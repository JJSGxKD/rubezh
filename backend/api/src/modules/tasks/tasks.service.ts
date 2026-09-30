import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { RunsHooks, type RecordedRun } from "../runs/runs-hooks.js";
import { WalletService } from "../wallet/wallet.service.js";
import type { WalletResource } from "../wallet/wallet-types.js";
import { TaskNotDoneError, TaskNotFoundError, TaskShapeLockedError } from "./tasks-errors.js";
import { TASK_KINDS, TASK_KIND_IDS, TASK_PERIODS, countsForTasks, rewardReason, type TaskDef, type TaskKind, type TaskPeriod } from "./task-rules.js";
import { TASKS_REPOSITORY, type TaskDelta, type TaskProgressRow, type TasksRepository } from "./tasks.repository.js";

/**
 * Задания и достижения (docs/35-stage4-plan.md Р52, WP13). Прогресс двигает
 * записанный забег — серверное событие, а не клиентская аналитика; забор —
 * начисление ключом задания и срока, потом отметка, как у награды дня: два
 * запроса разом начисляют однажды, а начисленное, но не отмеченное после
 * сбоя кошелёк узнает по ключу.
 *
 * Каталог правится из панели без релиза и держится в памяти: его читает
 * каждый записанный забег, а меняется он раз в неделю. Правка из панели
 * видна через полминуты.
 */

const DB_TIMEOUT_MS = 3_000;
const CATALOG_TTL_MS = 30_000;

export interface TaskView {
  id: string;
  period: TaskPeriod;
  kind: TaskKind;
  /** `null` — текст по виду цели у клиента */
  title: string | null;
  target: number;
  value: number;
  done: boolean;
  claimed: boolean;
  reward: { coins: number; gems: number; shards: number };
  passPoints: number;
}

export interface TaskCatalogView {
  tasks: TaskDef[];
  kinds: readonly TaskKind[];
  periods: readonly TaskPeriod[];
}

export interface TaskClaimResult {
  claimed: boolean;
  /** сколько легло на баланс; меньше награды — упёрлось в суточный потолок */
  credited: { coins: number; gems: number; shards: number };
  tasks: TaskView[];
}

/** Ресурс награды в кошельке: осколки заданий — обычные. */
const REWARD_RESOURCES = [
  ["coins", "coins"],
  ["gems", "gems"],
  ["shards", "shard_common"],
] as const satisfies readonly (readonly [keyof TaskView["reward"], WalletResource])[];

@Injectable()
export class TasksService implements OnModuleInit {
  private readonly logger = new Logger("tasks");
  private cache: { defs: TaskDef[]; until: number } | null = null;

  constructor(
    @Inject(TASKS_REPOSITORY) private readonly repository: TasksRepository,
    private readonly wallet: WalletService,
    private readonly runs: RunsHooks,
    private readonly roles: RolesService,
  ) {}

  onModuleInit(): void {
    this.runs.onRecorded("tasks", (run) => this.onRun(run));
  }

  async view(accountId: string, at = new Date()): Promise<TaskView[]> {
    const [defs, progress] = await Promise.all([this.active(), this.db(this.repository.progress(accountId, at))]);
    return viewOf(defs, progress);
  }

  async claim(accountId: string, taskId: string, at = new Date()): Promise<TaskClaimResult> {
    const [defs, progress] = await Promise.all([this.active(), this.db(this.repository.progress(accountId, at))]);
    const def = defs.find((candidate) => candidate.taskId === taskId);
    if (def === undefined) throw new TaskNotFoundError();
    const row = progress.find((candidate) => candidate.taskId === taskId);
    if (row === undefined || !row.done) throw new TaskNotDoneError();
    const none = { coins: 0, gems: 0, shards: 0 };
    if (row.claimed) return { claimed: false, credited: none, tasks: viewOf(defs, progress) };

    const credited = { ...none };
    for (const [field, resource] of REWARD_RESOURCES) {
      if (def[field] <= 0) continue;
      const result = await this.wallet.grant({
        accountId,
        resource,
        amount: def[field],
        reason: rewardReason(def.period),
        source: `task:${taskId}`,
        idempotencyKey: `task:${accountId}:${taskId}:${row.periodStart}:${resource}`,
        at,
      });
      credited[field] = result.credited;
    }
    const claimed = await this.db(this.repository.markClaimed(accountId, taskId, row.periodStart, at));
    if (claimed) this.logger.log(JSON.stringify({ module: "tasks", event: "task_claimed", accountId, taskId, period: def.period, ...credited }));
    const after = progress.map((candidate) => (candidate === row ? { ...row, claimed: true } : candidate));
    return { claimed, credited, tasks: viewOf(defs, after) };
  }

  /** Знак меню: сколько наград можно забрать прямо сейчас (Р50). */
  async badge(accountId: string, at = new Date()): Promise<number> {
    const progress = await this.db(this.repository.progress(accountId, at));
    return progress.filter((row) => row.done && !row.claimed).length;
  }

  /** Весь каталог, и выключенное, с видами и сроками для формы — панели. */
  async catalog(actor: AccountRef): Promise<TaskCatalogView> {
    await this.roles.require(actor, "tasks.edit");
    return { tasks: await this.db(this.repository.catalog()), kinds: TASK_KIND_IDS, periods: TASK_PERIODS };
  }

  /**
   * Строка каталога из панели: новый id — новое задание, известный — правка
   * цели, награды, текста, места и включённости. Срок и вид после создания
   * не меняются. Каждое изменение — в аудит.
   */
  async save(actor: AccountRef, task: TaskDef, at = new Date()): Promise<TaskDef> {
    await this.roles.require(actor, "tasks.edit");
    const before = (await this.db(this.repository.catalog())).find((candidate) => candidate.taskId === task.taskId) ?? null;
    if (before === null) {
      if (!(await this.db(this.repository.insert(task, actor.accountId, at)))) throw new TaskShapeLockedError();
      await this.roles.audit({ actorAccountId: actor.accountId, action: "tasks.create", target: task.taskId, after: task });
    } else {
      if (before.period !== task.period || before.kind !== task.kind) throw new TaskShapeLockedError();
      if (!(await this.db(this.repository.update(task, actor.accountId, at)))) throw new TaskNotFoundError();
      await this.roles.audit({ actorAccountId: actor.accountId, action: "tasks.update", target: task.taskId, before, after: task });
    }
    this.forgetCatalog();
    this.logger.log(JSON.stringify({ module: "tasks", event: before === null ? "task_created" : "task_updated", taskId: task.taskId, actor: actor.accountId }));
    return task;
  }

  /**
   * Записанный забег двигает цели. Слушатель работает после ответа игроку;
   * повтор события ничего не удваивает — забег засчитывается по `run_id`
   * однажды.
   */
  async onRun(run: RecordedRun): Promise<void> {
    if (!countsForTasks(run)) return;
    const deltas: TaskDelta[] = (await this.active()).map((def) => {
      const kind = TASK_KINDS[def.kind];
      return { taskId: def.taskId, period: def.period, target: def.target, op: kind.op, amount: kind.measure(run) };
    });
    if (deltas.every((delta) => delta.amount <= 0)) return;
    await this.db(this.repository.applyRun({ runId: run.runId, accountId: run.accountId, at: run.finishedAt, deltas }));
  }

  /** Правка каталога из панели видна сразу на этой реплике, на остальных — через полминуты. */
  forgetCatalog(): void {
    this.cache = null;
  }

  private async active(): Promise<TaskDef[]> {
    const now = Date.now();
    if (this.cache === null || this.cache.until <= now) {
      const defs = await this.db(this.repository.catalog());
      this.cache = { defs: defs.filter((def) => def.active), until: now + CATALOG_TTL_MS };
    }
    return this.cache.defs;
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "задания");
  }
}

/** Цели в порядке каталога: срок, место, id. Не двигавшаяся цель — с нулём. */
export function viewOf(defs: readonly TaskDef[], progress: readonly TaskProgressRow[]): TaskView[] {
  const byTask = new Map(progress.map((row) => [row.taskId, row]));
  return defs.map((def) => {
    const row = byTask.get(def.taskId);
    return {
      id: def.taskId,
      period: def.period,
      kind: def.kind,
      title: def.title,
      target: def.target,
      value: Math.min(row?.value ?? 0, def.target),
      done: row?.done ?? false,
      claimed: row?.claimed ?? false,
      reward: { coins: def.coins, gems: def.gems, shards: def.shards },
      passPoints: def.passPoints,
    };
  });
}
