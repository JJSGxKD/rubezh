import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { TASK_KIND_IDS, TASK_PERIODS, type TaskDef, type TaskKind, type TaskPeriod } from "./task-rules.js";

/**
 * Задания в базе: каталог (`task_def`), прогресс по срокам (`task_progress`)
 * и засчитанные забеги (`task_run`). Начало срока считает база — одна
 * граница суток и недели у всех реплик (`common/game-day.ts`).
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
});

const progressSchema = z.object({ task_id: z.string(), period_start: z.string(), value: z.number().int(), done: z.boolean(), claimed: z.boolean() });

function isKind(kind: string): kind is TaskKind {
  return (TASK_KIND_IDS as string[]).includes(kind);
}

@Injectable()
export class PrismaTasksRepository implements TasksRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async catalog(): Promise<TaskDef[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT task_id, period::text, kind, target, title, coins, gems, shards, pass_points, sort, active
      FROM task_def ORDER BY period, sort, task_id`;
    const defs: TaskDef[] = [];
    for (const raw of rows) {
      const row = defSchema.parse(raw);
      // Вид, которого этот сервер не знает, — строка из панели новее кода: её
      // нечем засчитывать, и она пропускается, а не роняет весь раздел.
      if (!isKind(row.kind)) continue;
      defs.push({
        taskId: row.task_id,
        period: row.period,
        kind: row.kind,
        target: row.target,
        title: row.title,
        coins: row.coins,
        gems: row.gems,
        shards: row.shards,
        passPoints: row.pass_points,
        sort: row.sort,
        active: row.active,
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

  async markClaimed(accountId: string, taskId: string, periodStart: string, at: Date): Promise<boolean> {
    return (
      (await this.prisma.$executeRaw`
        UPDATE task_progress SET claimed_at = ${at}, updated_at = ${at}
        WHERE account_id = ${accountId}::uuid AND task_id = ${taskId} AND period_start = ${periodStart}::date
          AND completed_at IS NOT NULL AND claimed_at IS NULL`) > 0
    );
  }
}
