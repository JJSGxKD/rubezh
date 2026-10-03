import { Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { TASK_KIND_IDS, TASK_PERIODS, taskParamsSchema, type TaskDef, type TaskKind, type TaskParticipation, type TaskPeriod } from "./task-rules.js";

/**
 * Задания в базе: каталог (`task_def`), прогресс по срокам (`task_progress`)
 * и засчитанные забеги (`task_run`). Начало срока считает база — одна
 * граница суток и недели у всех реплик (`common/game-day.ts`).
 *
 * Партнёрские цели ведут ещё и участников (`task_participant`, Р82): строку
 * на игрока с последним переходом и первым выполнением — по ней считается
 * лимит выполнений и мягкий час начавших.
 */

export interface TaskProgressRow {
  taskId: string;
  /** начало срока: сутки, понедельник недели или общий день достижений */
  periodStart: string;
  value: number;
  done: boolean;
  claimed: boolean;
}

export interface TaskDelta {
  taskId: string;
  period: TaskPeriod;
  target: number;
  op: "sum" | "max";
  amount: number;
}

export const TASKS_REPOSITORY = Symbol("TASKS_REPOSITORY");

export interface TasksRepository {
  /** весь каталог, и выключенные строки: их видит панель */
  catalog(): Promise<TaskDef[]>;
  /** прогресс по текущим срокам включённых заданий — только то, что уже двигалось */
  progress(accountId: string, at: Date): Promise<TaskProgressRow[]>;
  /** засчитать забег; `false` — этот забег уже засчитан */
  applyRun(input: { runId: string; accountId: string; at: Date; deltas: readonly TaskDelta[] }): Promise<boolean>;
  /** отметить забор; `false` — уже забрано параллельным запросом */
  markClaimed(accountId: string, taskId: string, periodStart: string, at: Date): Promise<boolean>;
  /**
   * Цель выполнена проверкой площадки или переходом, а не забегом (Р52):
   * прогресс срока — сразу цель. Первое выполнение игрока занимает место в
   * лимите — под блокировкой строки задания, сверх лимита только в мягкий
   * час от перехода не раньше `graceSince`. `null` — мест нет. Повтор
   * ничего не меняет: время выполнения остаётся первым.
   */
  complete(accountId: string, task: Pick<TaskDef, "taskId" | "period" | "target">, at: Date, graceSince: Date): Promise<TaskProgressRow | null>;
  /** игрок перешёл к партнёрской цели — от этого идёт мягкий час */
  markOpened(accountId: string, taskId: string, at: Date): Promise<void>;
  /** участие игрока во включённых партнёрских целях — с числом выполнивших */
  participation(accountId: string): Promise<Map<string, TaskParticipation>>;
  /** сколько игроков выполнили каждую цель — панели */
  completions(): Promise<Map<string, number>>;
  /** завести строку каталога; `false` — такой id уже есть */
  insert(task: TaskDef, actorAccountId: string, at: Date): Promise<boolean>;
  /** поправить строку каталога — всё, кроме срока и вида; `false` — строки нет */
  update(task: TaskDef, actorAccountId: string, at: Date): Promise<boolean>;
}

/**
 * Достижения — навсегда: их «срок» начинается одним днём у всех, и строка
 * прогресса у достижения одна.
 */
export const ACHIEVEMENT_PERIOD_START = "2000-01-01";

/** Начало срока задания в игровых сутках (по Москве): неделя — с понедельника. */
export function periodStartSql(period: Prisma.Sql, at: Date): Prisma.Sql {
  return Prisma.sql`(CASE ${period}
    WHEN 'daily' THEN (${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date
    WHEN 'weekly' THEN date_trunc('week', ${at}::timestamptz AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date
    ELSE DATE '${Prisma.raw(ACHIEVEMENT_PERIOD_START)}' END)`;
}

const defSchema = z.object({
  task_id: z.string(),
  completion_limit: z.number().int().nullable(),
  period: z.enum(TASK_PERIODS),
  kind: z.string(),
  target: z.number().int(),
  title: z.string().nullable(),
  coins: z.number().int(),
  gems: z.number().int(),
  shards: z.number().int(),
  pass_points: z.number().int(),
  sort: z.number().int(),
  active: z.boolean(),
  params: z.unknown(),
});

const progressSchema = z.object({ task_id: z.string(), period_start: z.string(), value: z.number().int(), done: z.boolean(), claimed: z.boolean() });

const participationSchema = z.object({ task_id: z.string(), completions: z.number().int(), opened_at: z.date().nullable(), completed_at: z.date().nullable() });

const participantSchema = z.object({ opened_at: z.date().nullable(), completed_at: z.date().nullable() });

function isKind(kind: string): kind is TaskKind {
  return (TASK_KIND_IDS as string[]).includes(kind);
}

@Injectable()
export class PrismaTasksRepository implements TasksRepository {
  private readonly logger = new Logger("tasks");

  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async catalog(): Promise<TaskDef[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT task_id, period::text, kind, target, title, coins, gems, shards, pass_points, sort, active, params, completion_limit
      FROM task_def ORDER BY period, sort, task_id`;
    const defs: TaskDef[] = [];
    for (const raw of rows) {
      const row = defSchema.parse(raw);
      // Вид, которого этот сервер не знает, — строка из панели новее кода: её
      // нечем засчитывать, и она пропускается, а не роняет весь раздел.
      if (!isKind(row.kind)) continue;
      const params = row.params === null ? null : taskParamsSchema.safeParse(row.params);
      if (params !== null && !params.success) {
        this.logger.error(JSON.stringify({ module: "tasks", event: "task_params_invalid", taskId: row.task_id }));
        continue;
      }
      defs.push({
        taskId: row.task_id,
        period: row.period,
        kind: row.kind,
        params: params === null ? null : params.data,
        target: row.target,
        title: row.title,
        coins: row.coins,
        gems: row.gems,
        shards: row.shards,
        passPoints: row.pass_points,
        sort: row.sort,
        active: row.active,
        limit: row.completion_limit,
      });
    }
    return defs;
  }

  async progress(accountId: string, at: Date): Promise<TaskProgressRow[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT p.task_id, p.period_start::text, p.value, p.completed_at IS NOT NULL AS done, p.claimed_at IS NOT NULL AS claimed
      FROM task_def d
      JOIN task_progress p ON p.account_id = ${accountId}::uuid AND p.task_id = d.task_id
        AND p.period_start = ${periodStartSql(Prisma.sql`d.period::text`, at)}
      WHERE d.active`;
    return rows.map((raw) => {
      const row = progressSchema.parse(raw);
      return { taskId: row.task_id, periodStart: row.period_start, value: row.value, done: row.done, claimed: row.claimed };
    });
  }

  async applyRun(input: { runId: string; accountId: string; at: Date; deltas: readonly TaskDelta[] }): Promise<boolean> {
    return await this.prisma.$transaction(async (tx) => {
      // Забег засчитывается однажды: повтор события после сбоя упрётся в ключ
      // и прогресс не удвоит. Ключ занимается в той же транзакции, что прогресс.
      const fresh = await tx.$executeRaw`
        INSERT INTO task_run (run_id, account_id, applied_at) VALUES (${input.runId}, ${input.accountId}::uuid, ${input.at})
        ON CONFLICT (run_id) DO NOTHING`;
      if (fresh === 0) return false;
      for (const op of ["sum", "max"] as const) {
        const deltas = input.deltas.filter((delta) => delta.op === op && delta.amount > 0);
        if (deltas.length === 0) continue;
        const merged = op === "sum" ? Prisma.sql`task_progress.value + EXCLUDED.value` : Prisma.sql`GREATEST(task_progress.value, EXCLUDED.value)`;
        // Прогресс не уходит за цель: «7 из 3» на экране — ошибка, а не заслуга.
        const next = Prisma.sql`LEAST(EXCLUDED.target, ${merged})`;
        await tx.$executeRaw`
          INSERT INTO task_progress (account_id, task_id, period_start, value, target, completed_at, updated_at)
          SELECT ${input.accountId}::uuid, u.task_id, ${periodStartSql(Prisma.sql`u.period`, input.at)},
                 LEAST(u.amount, u.target), u.target, CASE WHEN u.amount >= u.target THEN ${input.at}::timestamptz END, ${input.at}
          FROM unnest(${deltas.map((delta) => delta.taskId)}::text[], ${deltas.map((delta) => delta.period)}::text[],
                      ${deltas.map((delta) => delta.target)}::int[], ${deltas.map((delta) => delta.amount)}::int[]) AS u(task_id, period, target, amount)
          ON CONFLICT (account_id, task_id, period_start) DO UPDATE SET
            value = ${next},
            target = EXCLUDED.target,
            completed_at = COALESCE(task_progress.completed_at, CASE WHEN ${next} >= EXCLUDED.target THEN EXCLUDED.updated_at END),
            updated_at = EXCLUDED.updated_at`;
      }
      return true;
    });
  }

  async insert(task: TaskDef, actorAccountId: string, at: Date): Promise<boolean> {
    return (
      (await this.prisma.$executeRaw`
        INSERT INTO task_def (task_id, period, kind, target, title, coins, gems, shards, pass_points, sort, active, params, completion_limit, created_at, updated_at, updated_by)
        VALUES (${task.taskId}, ${task.period}::"TaskPeriod", ${task.kind}, ${task.target}, ${task.title}, ${task.coins}, ${task.gems}, ${task.shards},
                ${task.passPoints}, ${task.sort}, ${task.active}, ${paramsJson(task)}::jsonb, ${task.limit}, ${at}, ${at}, ${actorAccountId}::uuid)
        ON CONFLICT (task_id) DO NOTHING`) > 0
    );
  }

  async update(task: TaskDef, actorAccountId: string, at: Date): Promise<boolean> {
    // Срок и вид не меняются: прогресс игроков записан по сроку и засчитан
    // по виду, и смена любого из них сделала бы его чужим.
    return (
      (await this.prisma.$executeRaw`
        UPDATE task_def SET target = ${task.target}, title = ${task.title}, coins = ${task.coins}, gems = ${task.gems}, shards = ${task.shards},
          pass_points = ${task.passPoints}, sort = ${task.sort}, active = ${task.active}, params = ${paramsJson(task)}::jsonb,
          completion_limit = ${task.limit}, updated_at = ${at}, updated_by = ${actorAccountId}::uuid
        WHERE task_id = ${task.taskId}`) > 0
    );
  }

  async complete(accountId: string, task: Pick<TaskDef, "taskId" | "period" | "target">, at: Date, graceSince: Date): Promise<TaskProgressRow | null> {
    return await this.prisma.$transaction(async (tx) => {
      // Строка участника — под блокировкой: два забора игрока разом не займут
      // два места, а второй увидит, что место уже его.
      await tx.$executeRaw`
        INSERT INTO task_participant (task_id, account_id) VALUES (${task.taskId}, ${accountId}::uuid) ON CONFLICT (task_id, account_id) DO NOTHING`;
      const [raw] = await tx.$queryRaw<unknown[]>`
        SELECT opened_at, completed_at FROM task_participant WHERE task_id = ${task.taskId} AND account_id = ${accountId}::uuid FOR UPDATE`;
      const participant = participantSchema.parse(raw);
      if (participant.completed_at === null) {
        // Место — строкой задания: условие лимита проверяется на её свежей
        // версии под блокировкой, и сколько бы заборов ни пришло разом, сверх
        // лимита пройдут только начавшие в мягкий час.
        const grace = participant.opened_at !== null && participant.opened_at >= graceSince;
        const taken = await tx.$executeRaw`
          UPDATE task_def SET completions = completions + 1
          WHERE task_id = ${task.taskId} AND (completion_limit IS NULL OR completions < completion_limit OR ${grace})`;
        if (taken === 0) return null;
        await tx.$executeRaw`
          UPDATE task_participant SET completed_at = ${at} WHERE task_id = ${task.taskId} AND account_id = ${accountId}::uuid`;
      }
      const rows = await tx.$queryRaw<unknown[]>`
        INSERT INTO task_progress (account_id, task_id, period_start, value, target, completed_at, updated_at)
        VALUES (${accountId}::uuid, ${task.taskId}, ${periodStartSql(Prisma.sql`${task.period}::text`, at)}, ${task.target}, ${task.target}, ${at}, ${at})
        ON CONFLICT (account_id, task_id, period_start) DO UPDATE SET
          value = GREATEST(task_progress.value, EXCLUDED.value),
          completed_at = COALESCE(task_progress.completed_at, EXCLUDED.completed_at),
          updated_at = EXCLUDED.updated_at
        RETURNING task_id, period_start::text, value, completed_at IS NOT NULL AS done, claimed_at IS NOT NULL AS claimed`;
      const row = progressSchema.parse(rows[0]);
      return { taskId: row.task_id, periodStart: row.period_start, value: row.value, done: row.done, claimed: row.claimed };
    });
  }

  async markOpened(accountId: string, taskId: string, at: Date): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO task_participant (task_id, account_id, opened_at) VALUES (${taskId}, ${accountId}::uuid, ${at})
      ON CONFLICT (task_id, account_id) DO UPDATE SET opened_at = EXCLUDED.opened_at`;
  }

  async participation(accountId: string): Promise<Map<string, TaskParticipation>> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT d.task_id, d.completions, p.opened_at, p.completed_at
      FROM task_def d LEFT JOIN task_participant p ON p.task_id = d.task_id AND p.account_id = ${accountId}::uuid
      WHERE d.active AND d.params IS NOT NULL`;
    return new Map(
      rows.map((raw) => {
        const row = participationSchema.parse(raw);
        return [row.task_id, { completions: row.completions, openedAt: row.opened_at, completedAt: row.completed_at }];
      }),
    );
  }

  async completions(): Promise<Map<string, number>> {
    const rows = await this.prisma.$queryRaw<unknown[]>`SELECT task_id, completions FROM task_def WHERE completions > 0`;
    return new Map(
      rows.map((raw) => {
        const row = z.object({ task_id: z.string(), completions: z.number().int() }).parse(raw);
        return [row.task_id, row.completions];
      }),
    );
  }

  async markClaimed(accountId: string, taskId: string, periodStart: string, at: Date): Promise<boolean> {
    return (
      (await this.prisma.$executeRaw`
        UPDATE task_progress SET claimed_at = ${at}, updated_at = ${at}
        WHERE account_id = ${accountId}::uuid AND task_id = ${taskId} AND period_start = ${periodStart}::date
          AND completed_at IS NOT NULL AND claimed_at IS NULL`) > 0
    );
  }
}

/** Параметры цели в колонку `jsonb`: у целей забега — пусто. */
function paramsJson(task: Pick<TaskDef, "params">): string | null {
  return task.params === null ? null : JSON.stringify(task.params);
}
