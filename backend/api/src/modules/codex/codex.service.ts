import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { AccountRef } from "../roles/roles.service.js";
import { RunsHooks, type RecordedRun } from "../runs/runs-hooks.js";
import { STATE_KINDS, countsForTasks } from "../tasks/task-rules.js";
import type { TaskDelta } from "../tasks/tasks.repository.js";
import { TasksService } from "../tasks/tasks.service.js";
import { CODEX_ENEMY_IDS, CODEX_REWARD_TASK_ID, newEntries, percentOf } from "./codex-rules.js";
import { CODEX_REPOSITORY, type CodexRepository } from "./codex.repository.js";

/**
 * Кодекс врагов (docs/39-retention-mechanics.md К2, tasks/T-0127): враг
 * открывается, когда игрок встретил его в забеге. Запись идёт по первой записи
 * забега — слушателем `RunsHooks`, после ответа игроку, — и только для забегов,
 * которые засчитываются заданиям: читы и отклонённые разбором записей не
 * открывают.
 *
 * Награда — достижения лестницы `codex`, вид `codex_percent`: процент открытого
 * кодекса дописывается в прогресс заданий с действием «максимум», поэтому он не
 * убывает, когда список врагов растёт, а выполненное остаётся выполненным.
 */

const DB_TIMEOUT_MS = 3_000;

export interface CodexReward {
  taskId: string;
  value: number;
  target: number;
  done: boolean;
  claimed: boolean;
  coins: number;
  prestige: number;
}

export interface CodexView {
  /** сколько врагов в кодексе сейчас — по таблице сервера, а не по клиенту */
  total: number;
  opened: { enemy: string; firstSeenAt: string }[];
  percent: number;
  /** награда за полный кодекс; `null` — строка выключена в панели или удалена */
  reward: CodexReward | null;
}

@Injectable()
export class CodexService implements OnModuleInit {
  private readonly logger = new Logger("codex");

  constructor(
    @Inject(CODEX_REPOSITORY) private readonly repository: CodexRepository,
    private readonly tasks: TasksService,
    private readonly runs: RunsHooks,
  ) {}

  onModuleInit(): void {
    this.runs.onRecorded("codex", (run) => this.onRun(run));
  }

  /**
   * Записанный забег открывает новые записи. Сбой не ломает забег: слушатель
   * работает после ответа игроку, а недописанный процент дозапишет следующий
   * заход в кодекс.
   */
  async onRun(run: RecordedRun): Promise<void> {
    try {
      if (!countsForTasks(run)) return;
      const known = new Set((await this.db(this.repository.opened(run.accountId))).map((entry) => entry.enemyId));
      const fresh = newEntries(run, known);
      if (fresh.length === 0) return;
      const inserted = await this.db(this.repository.open(run.accountId, fresh, run.finishedAt));
      if (inserted.length === 0) return;
      await this.syncPercent(run.accountId, known.size + inserted.length, run.finishedAt);
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "codex", event: "codex_failed", runId: run.runId, accountId: run.accountId, reason: error instanceof Error ? error.message : "unknown" }));
    }
  }

  async view(account: AccountRef, at = new Date()): Promise<CodexView> {
    const entries = await this.db(this.repository.opened(account.accountId));
    // Знаем только врагов из таблицы: запись про удалённого из контента в процент не идёт.
    const listed = entries.filter((entry) => CODEX_ENEMY_IDS.includes(entry.enemyId));
    const total = CODEX_ENEMY_IDS.length;
    const percent = percentOf(listed.length, total);
    // Старый аккаунт, которому хук не открывал записей, и список, вырос — значение дописывается до ответа.
    await this.syncPercent(account.accountId, listed.length, at);
    const reward = (await this.tasks.view(account, at)).find((task) => task.id === CODEX_REWARD_TASK_ID);
    return {
      total,
      opened: listed.map((entry) => ({ enemy: entry.enemyId, firstSeenAt: entry.firstSeenAt.toISOString() })),
      percent,
      reward:
        reward === undefined
          ? null
          : { taskId: reward.id, value: reward.value, target: reward.target, done: reward.done, claimed: reward.claimed, coins: reward.reward.coins, prestige: reward.prestige },
    };
  }

  /** Дописать процент во все включённые строки вида `codex_percent`. */
  private async syncPercent(accountId: string, opened: number, at: Date): Promise<void> {
    const defs = (await this.tasks.achievementDefs()).filter((def) => def.kind === "codex_percent");
    if (defs.length === 0) return;
    const amount = percentOf(opened, CODEX_ENEMY_IDS.length);
    const deltas = defs.map((def): TaskDelta => ({ taskId: def.taskId, period: def.period, target: def.target, op: STATE_KINDS.codex_percent.op, amount }));
    await this.tasks.applyState(accountId, deltas, at);
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "кодекс");
  }
}
