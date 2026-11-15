import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { RunsHooks, type RecordedRun } from "../runs/runs-hooks.js";
import { STATE_KINDS, countsForTasks } from "../tasks/task-rules.js";
import type { TaskDelta } from "../tasks/tasks.repository.js";
import { TasksService } from "../tasks/tasks.service.js";
import { SECRETS_CODEX_KINDS, isSecretKind, newKinds, secretsKindsAmount, type SecretKind } from "./secrets-codex-rules.js";
import { SECRETS_CODEX_REPOSITORY, type SecretsCodexRepository } from "./secrets-codex.repository.js";

/**
 * Кодекс тайников (docs/35-stage4-plan.md Р153, design/art/meta-v2.md §5.3,
 * tasks/T-0261): вид тайника открывается, когда игрок нашёл его в забеге. Запись
 * идёт по первой записи забега — слушателем `RunsHooks`, после ответа игроку, — и
 * только для забегов, которые засчитываются заданиям: читы, отклонённые разбором
 * записей и пролог ничего не открывают.
 *
 * Награда — достижение «Следопыт», вид `secrets_kinds`: число найденных видов
 * дописывается в прогресс заданий с действием «максимум», поэтому выполненное
 * остаётся выполненным, а знак у имени держится.
 */

const DB_TIMEOUT_MS = 3_000;

export interface SecretsCodexView {
  /** найденные виды в каноническом порядке */
  found: SecretKind[];
}

@Injectable()
export class SecretsCodexService implements OnModuleInit {
  private readonly logger = new Logger("secrets-codex");

  constructor(
    @Inject(SECRETS_CODEX_REPOSITORY) private readonly repository: SecretsCodexRepository,
    private readonly tasks: TasksService,
    private readonly runs: RunsHooks,
  ) {}

  onModuleInit(): void {
    this.runs.onRecorded("secrets-codex", (run) => this.onRun(run));
  }

  /**
   * Записанный забег открывает новые виды. Сбой не ломает забег: слушатель
   * работает после ответа игроку, а недописанный прогресс дозапишет следующий
   * забег с находкой.
   */
  async onRun(run: RecordedRun): Promise<void> {
    try {
      if (!countsForTasks(run)) return;
      if ((run.secretsFound ?? []).length === 0) return;
      const known = new Set((await this.db(this.repository.found(run.accountId))).map((entry) => entry.kind));
      const fresh = newKinds(run, known);
      if (fresh.length === 0) return;
      const inserted = await this.db(this.repository.record(run.accountId, fresh, run.finishedAt));
      if (inserted.length === 0) return;
      await this.syncProgress(run.accountId, secretsKindsAmount(new Set([...known, ...inserted])), run.finishedAt);
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "secrets-codex", event: "secrets_codex_failed", runId: run.runId, accountId: run.accountId, reason: error instanceof Error ? error.message : "unknown" }));
    }
  }

  async view(accountId: string): Promise<SecretsCodexView> {
    const entries = await this.db(this.repository.found(accountId));
    // Запись про вид, которого в движке больше нет, клиенту не отдаётся.
    const known = new Set(entries.map((entry) => entry.kind).filter(isSecretKind));
    return { found: SECRETS_CODEX_KINDS.filter((kind) => known.has(kind)) };
  }

  /** Дописать число найденных видов во все включённые строки вида `secrets_kinds`. */
  private async syncProgress(accountId: string, amount: number, at: Date): Promise<void> {
    const defs = (await this.tasks.achievementDefs()).filter((def) => def.kind === "secrets_kinds");
    if (defs.length === 0) return;
    const deltas = defs.map((def): TaskDelta => ({ taskId: def.taskId, period: def.period, target: def.target, op: STATE_KINDS.secrets_kinds.op, amount }));
    await this.tasks.applyState(accountId, deltas, at);
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "кодекс тайников");
  }
}
