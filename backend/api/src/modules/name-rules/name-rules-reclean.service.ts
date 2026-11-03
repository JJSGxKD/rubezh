import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { cleanAll, type CleanResult } from "../../cli/display-names-clean.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { REDIS } from "../../infra/redis.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { NameRuleConflictError } from "./name-rules-errors.js";
import {
  RECLEAN_LOCK_KEY,
  RECLEAN_LOCK_TTL_MS,
  RECLEAN_PAGE_PAUSE_MS,
  RECLEAN_PREVIEW_TTL_MS,
  RECLEAN_STATE_KEY,
  RECLEAN_STOP_KEY,
  RECLEAN_STOP_TTL_SEC,
  readRecleanState,
  writeRecleanState,
  type RecleanMode,
  type RecleanState,
} from "./name-rules-reclean-state.js";
import { loadNameRuleSet } from "./name-rules.repository.js";

/**
 * Перечистка ников из панели (docs/35-stage4-plan.md, Р168, tasks/T-0339).
 * Предпросмотр — тот же проход в режиме «сухой прогон», поэтому число «затронет
 * N» равно тому, что изменит запуск. Запуск открыт только после свежего
 * предпросмотра при тех же правилах. Задание одно на весь сервер (замок в
 * Redis); сам проход идёт в воркере очереди пачками, ход и итог лежат в
 * состоянии. Шаблоны правил и ники в лог и в состояние не попадают.
 */

const REDIS_TIMEOUT_MS = 2_000;
const FAILED_TEXT = "Перечистка прервалась — смотрите журнал сервера";
const LOST_TEXT = "Перечистка прервалась — запустите заново";
const STALE_RULES_TEXT = "Правила изменились — запустите заново";

/** Скрипты сверяют токен: чужой замок не продлевается и не снимается. */
const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

/** Что кладётся в очередь: сама работа берётся из состояния по `runId`. */
export interface RecleanJobData {
  runId: string;
  mode: RecleanMode;
  /** токен замка, взятого при постановке: воркер продлевает и снимает именно его */
  lockToken: string;
}

export interface RecleanEnqueuer {
  enqueue(data: RecleanJobData): Promise<void>;
}

/** Токен очереди: сервис знает только порт, а воркер получает сервис позже (без цикла зависимостей). */
export const RECLEAN_QUEUE = Symbol("RECLEAN_QUEUE");

@Injectable()
export class NameRulesRecleanService {
  private readonly logger = new Logger("name-rules");
  /** Пауза между пачками; тест подменяет, чтобы не ждать. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  now: () => Date = () => new Date();

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly roles: RolesService,
    @Inject(RECLEAN_QUEUE) private readonly queue: RecleanEnqueuer,
  ) {}

  /**
   * Последнее состояние. «Идёт», но замка нет — процесс упал: так панель не
   * показывает вечный прогресс и позволяет запустить заново.
   */
  async state(actor: AccountRef): Promise<RecleanState | null> {
    await this.roles.require(actor, "names.edit");
    const state = await readRecleanState(this.redis);
    if (state === null || (state.status !== "queued" && state.status !== "running")) return state;
    if ((await this.guarded(this.redis.exists(RECLEAN_LOCK_KEY), "замок")) > 0) return state;
    const lost: RecleanState = { ...state, status: "failed", finishedAt: this.now().toISOString(), error: LOST_TEXT };
    await writeRecleanState(this.redis, lost);
    return lost;
  }

  async startPreview(actor: AccountRef): Promise<RecleanState> {
    await this.roles.require(actor, "names.edit");
    return await this.begin(actor, "preview", async () => null);
  }

  async startRun(actor: AccountRef, input: { previewRunId: string }): Promise<RecleanState> {
    await this.roles.require(actor, "names.edit");
    return await this.begin(actor, "run", async (signature) => {
      const preview = await readRecleanState(this.redis);
      if (preview === null || preview.mode !== "preview" || preview.status !== "done" || preview.runId !== input.previewRunId) {
        throw new NameRuleConflictError("Сначала посчитайте, сколько ников затронет перечистка");
      }
      if (this.now().getTime() - Date.parse(preview.finishedAt ?? preview.startedAt) > RECLEAN_PREVIEW_TTL_MS) throw new NameRuleConflictError("Предпросмотр устарел — посчитайте заново");
      if (preview.signature !== signature) throw new NameRuleConflictError("Правила изменились после предпросмотра — посчитайте заново");
      return preview;
    });
  }

  async stop(actor: AccountRef): Promise<RecleanState | null> {
    await this.roles.require(actor, "names.edit");
    const state = await this.state(actor);
    if (state === null || (state.status !== "queued" && state.status !== "running")) throw new NameRuleConflictError("Перечистка не идёт");
    await this.guarded(this.redis.set(RECLEAN_STOP_KEY, "1", "EX", RECLEAN_STOP_TTL_SEC), "флаг остановки");
    await this.roles.audit({ actorAccountId: actor.accountId, action: "names.reclean.stop", target: state.runId });
    return state;
  }

  /**
   * Работа воркера. Задание от прежнего запуска (состояние уже другое) ничего
   * не делает и чужого замка не трогает.
   */
  async process(job: RecleanJobData): Promise<void> {
    const queued = await readRecleanState(this.redis);
    if (queued === null || queued.runId !== job.runId) return;
    let current: RecleanState = { ...queued, status: "running" };
    await writeRecleanState(this.redis, current);
    let stopped = false;
    try {
      const rules = await loadNameRuleSet(this.prisma);
      if (rules.signature !== queued.signature) {
        await writeRecleanState(this.redis, { ...current, status: "failed", finishedAt: this.now().toISOString(), error: STALE_RULES_TEXT });
        return;
      }
      const result = await cleanAll(
        this.prisma,
        { dryRun: job.mode === "preview" },
        {
          onPage: async (progress) => {
            current = { ...current, ...counters(progress) };
            await this.guarded(this.redis.eval(RENEW_SCRIPT, 1, RECLEAN_LOCK_KEY, job.lockToken, RECLEAN_LOCK_TTL_MS) as Promise<unknown>, "продление замка");
            await writeRecleanState(this.redis, current);
            await this.sleep(RECLEAN_PAGE_PAUSE_MS);
          },
          shouldStop: async () => {
            stopped = (await this.guarded(this.redis.get(RECLEAN_STOP_KEY), "флаг остановки")) !== null;
            return stopped;
          },
        },
        rules,
      );
      const finished: RecleanState = { ...current, ...counters(result), status: stopped ? "stopped" : "done", finishedAt: this.now().toISOString() };
      await writeRecleanState(this.redis, finished);
      if (job.mode === "run") {
        await this.roles.audit({ actorAccountId: queued.startedBy, action: "names.reclean.finish", target: job.runId, after: { status: finished.status, ...counters(result) } });
      }
      this.logger.log(JSON.stringify({ module: "name-rules", event: "reclean_finished", mode: job.mode, status: finished.status, ...counters(result) }));
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "name-rules", event: "reclean_failed", reason: error instanceof Error ? error.name : "unknown" }));
      try {
        await writeRecleanState(this.redis, { ...current, status: "failed", finishedAt: this.now().toISOString(), error: FAILED_TEXT });
      } catch (writeError: unknown) {
        this.logger.warn(JSON.stringify({ module: "name-rules", event: "reclean_state_not_written", reason: writeError instanceof Error ? writeError.name : "unknown" }));
      }
    } finally {
      await this.cleanup(job.lockToken);
    }
  }

  /**
   * Общая часть постановки: замок, проверка допуска, состояние `queued`, задание.
   * Допуск проверяется под замком: между проверкой и постановкой другой запуск
   * не вклинится. Не поставилось — замок снят, прежнее состояние возвращено.
   */
  private async begin(actor: AccountRef, mode: RecleanMode, admit: (signature: string) => Promise<RecleanState | null>): Promise<RecleanState> {
    const token = randomUUID();
    if ((await this.guarded(this.redis.set(RECLEAN_LOCK_KEY, token, "PX", RECLEAN_LOCK_TTL_MS, "NX"), "замок")) === null) throw new NameRuleConflictError("Перечистка уже идёт");
    let previous: RecleanState | null = null;
    try {
      const rules = await loadNameRuleSet(this.prisma);
      previous = await readRecleanState(this.redis);
      const preview = await admit(rules.signature);
      const state: RecleanState = {
        runId: randomUUID(),
        mode,
        status: "queued",
        signature: rules.signature,
        scanned: 0,
        planned: 0,
        updated: 0,
        skipped: 0,
        locked: 0,
        startedAt: this.now().toISOString(),
        finishedAt: null,
        startedBy: actor.accountId,
        error: null,
      };
      // Флаг от прошлой остановки не должен погасить новый проход.
      await this.guarded(this.redis.del(RECLEAN_STOP_KEY), "флаг остановки");
      await writeRecleanState(this.redis, state);
      try {
        await this.queue.enqueue({ runId: state.runId, mode, lockToken: token });
      } catch (error: unknown) {
        if (previous === null) await this.guarded(this.redis.del(RECLEAN_STATE_KEY), "состояние");
        else await writeRecleanState(this.redis, previous);
        throw error;
      }
      if (mode === "run" && preview !== null) {
        await this.roles.audit({ actorAccountId: actor.accountId, action: "names.reclean.start", target: state.runId, after: { previewRunId: preview.runId, planned: preview.planned, signature: preview.signature } });
      }
      return state;
    } catch (error: unknown) {
      await this.release(token);
      throw error;
    }
  }

  private async cleanup(token: string): Promise<void> {
    await this.release(token);
    try {
      await this.guarded(this.redis.del(RECLEAN_STOP_KEY), "флаг остановки");
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "name-rules", event: "reclean_stop_flag_not_cleared", reason: error instanceof Error ? error.name : "unknown" }));
    }
  }

  /** Замок живёт не дольше TTL: не снялся — следующий запуск увидит его свободным через две минуты. */
  private async release(token: string): Promise<void> {
    try {
      await this.guarded(this.redis.eval(RELEASE_SCRIPT, 1, RECLEAN_LOCK_KEY, token) as Promise<unknown>, "снятие замка");
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "name-rules", event: "reclean_lock_not_released", reason: error instanceof Error ? error.name : "unknown" }));
    }
  }

  private async guarded<T>(promise: Promise<T>, what: string): Promise<T> {
    return await withTimeout(promise, REDIS_TIMEOUT_MS, `перечистка: ${what}`);
  }
}

function counters(progress: CleanResult): Pick<RecleanState, "scanned" | "planned" | "updated" | "skipped" | "locked"> {
  return { scanned: progress.scanned, planned: progress.planned, updated: progress.updated, skipped: progress.skipped, locked: progress.locked };
}
