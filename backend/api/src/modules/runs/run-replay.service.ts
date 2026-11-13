import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { DomainError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { EVENT_DICTIONARY } from "../events/event-dictionary.js";
import type { EventRow } from "../events/events.repository.js";
import { EVENTS_SINK, type EventsSink } from "../events/events.sink.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { RUN_PROOFS_REPOSITORY, type RunProofsRepository } from "./run-proofs.repository.js";
import type { FinishedReplayJob, ReplayJobPayload, ReplayQueue } from "./run-replay.job.js";
import {
  clientOsOf,
  decideReplay,
  effectOf,
  jobIdOf,
  jobPriorityOf,
  mismatchVerdictOf,
  parseJobId,
  REPLAY_NO_PROOF_HOURS,
  REPLAY_REQUEUE_MINUTES,
  REPLAY_SILENT_HOURS,
  replayResultSchema,
  type ReplayFacts,
  type ReplayOutcome,
  type ReplayReason,
  type ReplayResult,
  type ReplayState,
  type ReplayedTotals,
} from "./run-replay-rules.js";
import { RUN_REPLAY_REPOSITORY, type ReplayRunRow, type RunReplayRepository } from "./run-replay.repository.js";
import { RUN_PROOF_LIMITS } from "./runs-limits.js";
import type { RecordedRun } from "./runs-hooks.js";
import { RunNotFoundError } from "./runs-view.service.js";
import { RunsService } from "./runs.service.js";

/**
 * Перепроверка забегов повтором (docs/35-stage4-plan.md WP5, tasks/T-0319).
 *
 * Путь забега: записан → `onRecorded` решает, нужен ли повтор (`run-replay-rules.ts`), и
 * ставит строку «ожидает»; запись для проверки пришла → `onProofStored` ставит задание в
 * очередь `replay`; `sim-worker` повторяет; проход `sweep` читает исход и кладёт его в
 * забег: совпал — вердикт прежний, разошёлся — подозрение и уход из рейтинга в разбор.
 *
 * **Идемпотентность.** Постановку занимает условное обновление строки (одна реплика из
 * нескольких), задание в очереди — по идентификатору забег+попытка (повторная постановка
 * той же попытки не плодит заданий), исход закрывается условным обновлением по состоянию
 * «ожидает» и номеру попытки (повторная доставка, две реплики и исход прошлой попытки
 * ничего не меняют второй раз). Что исход сделал с вердиктом, рейтингом и записью — одной
 * транзакцией репозитория.
 *
 * **Сторона сервера не наказывает.** Не тот снимок контента, упавший воркер, предел времени
 * и молчащая очередь — исход записывается, вердикт и рейтинг остаются, в лог идёт предупреждение.
 */

/** Очередь повтора — за портом: реальная живёт в `run-replay.job.ts`, в тестах — на памяти. */
export const REPLAY_QUEUE = Symbol("REPLAY_QUEUE");

/** Откуда берутся числа о месте забега в досках — отдельным читателем, чтобы правила не знали о Redis. */
export const RUN_REPLAY_FACTS = Symbol("RUN_REPLAY_FACTS");

export interface ReplayFactsReader {
  of(run: RecordedRun): Promise<ReplayFacts>;
}

/** Часы и вывод строк — подменяются в тестах. */
export interface ReplayEnvironment {
  now(): Date;
  log(line: string, level?: "warn"): void;
}

export const REPLAY_ENVIRONMENT = Symbol("REPLAY_ENVIRONMENT");

/** Снимок контента больше этого воркер не разбирает (`SNAPSHOT_MAX_BYTES` в `apps/sim-worker/src/limits.ts`). */
export const REPLAY_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

/** Заданий за один проход на каждый шаг: остальное доберёт следующий проход. */
const BATCH = 200;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * HOUR_MS;
const EVENT_TIMEOUT_MS = 2_000;
const gunzipAsync = promisify(gunzip);

/** Идёт ли повтор прямо сейчас: второе нажатие «Повторить снова» ничего не добавляет. */
export class RunReplayPendingError extends DomainError {
  constructor() {
    super("run_replay_pending", "Повтор этого забега уже идёт", 409);
  }
}

/** Записи нет (срок хранения вышел или она не пришла): повторять нечего. */
export class RunReplayNoProofError extends DomainError {
  constructor() {
    super("run_replay_no_proof", "Записи забега для проверки нет — повторять нечего", 409);
  }
}

/** Что показать в разборе: исход, тик расхождения и таблица «заявлено / повтор». */
export interface ReplayView {
  /** `null` — повтор забегу не назначали */
  verdict: ReplayState | null;
  required: boolean;
  divergedTick: number | null;
  replayedAt: string | null;
  /** что воркер сказал словами; у совпавшего пусто */
  reason: string | null;
  durationMs: number | null;
  claimed: { survivalSec: number; level: number; enemiesKilled: number };
  replayed: ReplayedTotals | null;
  hasProof: boolean;
  /** кнопка «Повторить снова»: запись жива и повтор сейчас не идёт */
  canRepeat: boolean;
}

export interface SweepReport {
  harvested: number;
  queued: number;
  requeued: number;
  expired: number;
}

interface Outcome {
  verdict: ReplayOutcome;
  reason: string | null;
  divergedTick: number | null;
  replayed: ReplayedTotals | null;
  durationMs: number;
}

@Injectable()
export class RunReplayService {
  private readonly logger = new Logger("run-replay");
  private readonly environment: ReplayEnvironment;

  constructor(
    @Inject(RUN_REPLAY_REPOSITORY) private readonly repository: RunReplayRepository,
    @Inject(RUN_PROOFS_REPOSITORY) private readonly proofs: RunProofsRepository,
    @Inject(REPLAY_QUEUE) private readonly queue: ReplayQueue,
    // Только то, что нужно: после снятия забега с рейтинга доски пересчитывает сервис забегов.
    @Inject(RunsService) private readonly runs: Pick<RunsService, "syncBoardsAfterReplay">,
    @Inject(RUN_REPLAY_FACTS) private readonly facts: ReplayFactsReader,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(RolesService) private readonly roles: Pick<RolesService, "audit" | "require">,
    // Без писателя событий (сбой подключения, тесты других модулей) повтор работает: события нет, метрика остаётся строкой лога.
    @Optional() @Inject(EVENTS_SINK) private readonly sink: EventsSink | null = null,
    @Optional() @Inject(REPLAY_ENVIRONMENT) environment?: ReplayEnvironment,
  ) {
    this.environment = environment ?? {
      now: () => new Date(),
      log: (line, level) => (level === "warn" ? this.logger.warn(line) : this.logger.log(line)),
    };
  }

  /**
   * Забег записан: нужен ли ему повтор. Обязательный и выборочный получают строку
   * «ожидает»; нужна и запись — тогда задание ставится сразу. Ошибку не глотаем: слушатель
   * `RunsHooks` пишет её в лог, ответ игроку к этому моменту давно ушёл.
   */
  async onRecorded(run: RecordedRun): Promise<void> {
    const facts = await this.facts.of(run);
    const decision = decideReplay(run.runId, facts, this.settings.get(SETTINGS.replaySampleRate) / 100);
    if (decision.need === "none") return;
    const required = decision.need === "required";
    if (await this.repository.markPending(run.runId, required)) {
      this.note("replay_requested", { runId: run.runId, required, reasons: decision.need === "required" ? decision.reasons : ["sample"] });
    }
    await this.enqueue(run.runId, false);
  }

  /** Запись для проверки принята: если забегу нужен повтор — ставим задание. */
  async onProofStored(runId: string): Promise<void> {
    await this.enqueue(runId, false);
  }

  /**
   * Повтор оказался обязателен позже, чем забег записан: например, выпала эпическая добыча
   * (`lootNeedsReplay`). Забег без строки «ожидает» получает её, выборочный становится
   * обязательным — приоритет задания и последствия для наград (T-0320) считаются по нему.
   */
  async require(runId: string, reason: ReplayReason): Promise<void> {
    if (await this.repository.markPending(runId, true)) this.note("replay_requested", { runId, required: true, reasons: [reason] });
    await this.enqueue(runId, false);
  }

  /**
   * Проход раз в минуту: снять исходы, поставить задания, которых ждёт запись, поставить
   * заново потерянные, закрыть тишину. Шаги независимы: недоступный Redis не мешает закрыть
   * «записи нет», а упавший шаг пишется в лог и не обрывает остальные.
   */
  async sweep(): Promise<SweepReport> {
    return {
      harvested: await this.step("harvest", () => this.harvest()),
      queued: await this.step("queue_due", () => this.queueDue()),
      requeued: await this.step("requeue", () => this.requeueStale()),
      expired: await this.step("expire", () => this.expireWithoutProof()),
    };
  }

  /**
   * «Повторить снова» (панель, право `players.restrict`): забег возвращается в «ожидает» с
   * новой попыткой, задание уходит с высоким приоритетом, действие пишется в журнал с прежним
   * исходом. Повтор уже идёт — 409, записи нет — 409: оба раза ничего не меняется.
   */
  async repeat(actor: AccountRef, runId: string): Promise<ReplayView> {
    await this.roles.require(actor, "players.restrict");
    const before = await this.repository.find(runId);
    if (before === null || before.status !== "finished") throw new RunNotFoundError();
    const previous = (await this.repository.outcomesOf([runId])).get(runId) ?? null;

    const reset = await this.repository.reset(runId);
    if (reset.status === "missing") throw new RunNotFoundError();
    if (reset.status === "pending") throw new RunReplayPendingError();
    if (reset.status === "no_proof") throw new RunReplayNoProofError();

    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "players.run.replay",
      target: before.accountId,
      before: { replayVerdict: before.replayVerdict, divergedTick: previous?.divergedTick ?? null },
      after: { runId },
    });
    this.note("replay_repeated", { runId, attempt: reset.attempt });
    await this.enqueue(runId, true);
    return await this.view(runId);
  }

  /** Исход и таблица для страницы отчёта забега. */
  async view(runId: string): Promise<ReplayView> {
    const row = await this.repository.find(runId);
    if (row === null || row.status !== "finished") throw new RunNotFoundError();
    const stored = (await this.repository.outcomesOf([runId])).get(runId) ?? null;
    const hasProof = stored?.hasProof ?? (await this.proofs.find(runId)) !== null;
    const verdict = stored?.verdict ?? null;
    return {
      verdict,
      required: stored?.required ?? row.replayRequired,
      divergedTick: stored?.divergedTick ?? null,
      replayedAt: stored?.replayedAt?.toISOString() ?? null,
      reason: stored?.result?.reason ?? null,
      durationMs: stored?.result?.durationMs ?? null,
      claimed: { survivalSec: row.survivalSec ?? 0, level: row.level ?? 0, enemiesKilled: row.enemiesKilled ?? 0 },
      replayed: stored?.result?.replayed ?? null,
      hasProof,
      canRepeat: hasProof && verdict !== "pending",
    };
  }

  /** Исходы забегов пачкой — для строк очереди разбора; у забега без повтора записи нет. */
  async outcomes(runIds: readonly string[]): Promise<Map<string, { verdict: ReplayState; divergedTick: number | null }>> {
    const stored = await this.repository.outcomesOf(runIds);
    return new Map([...stored].map(([runId, outcome]) => [runId, { verdict: outcome.verdict, divergedTick: outcome.divergedTick }]));
  }

  // -- постановка ----------------------------------------------------------------------------

  /** Поставить задание, если забег ждёт повтора и запись уже есть; повторный вызов ничего не добавляет. */
  private async enqueue(runId: string, byModerator: boolean): Promise<boolean> {
    const row = await this.repository.find(runId);
    if (row === null || row.status !== "finished" || row.replayVerdict !== "pending") return false;
    const stored = await this.proofs.find(runId);
    // Записи ещё нет: забег ждёт, её приход (`onProofStored`) поставит задание.
    if (stored === null) return false;
    const at = this.environment.now();
    const attempt = await this.repository.claimQueue(runId, at);
    if (attempt === null) return false;
    await this.submit(row, attempt, stored.proof, byModerator, at);
    return true;
  }

  /** Собрать задание и отдать очереди; недоступная очередь — снять отметку, чтобы следующий проход повторил. */
  private async submit(row: ReplayRunRow, attempt: number, packed: Uint8Array, byModerator: boolean, claimedAt: Date): Promise<void> {
    let payload: ReplayJobPayload;
    try {
      payload = await this.payloadOf(row, packed);
    } catch (error: unknown) {
      // Запись прошла проверку при приёме, поэтому нечитаемой она быть не может — разве что хранилище повреждено. Это не вина игрока.
      await this.apply(row, attempt, { verdict: "broken", reason: `запись не читается: ${error instanceof Error ? error.message.slice(0, 120) : "неизвестная ошибка"}`, divergedTick: null, replayed: null, durationMs: 0 });
      return;
    }
    try {
      await this.queue.add(payload, { jobId: jobIdOf(row.runId, attempt), priority: jobPriorityOf({ required: row.replayRequired, byModerator }) });
    } catch (error: unknown) {
      await this.repository.releaseQueue(row.runId, claimedAt);
      this.note("replay_enqueue_failed", { runId: row.runId, reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" }, "warn");
    }
  }

  private async payloadOf(row: ReplayRunRow, packed: Uint8Array): Promise<ReplayJobPayload> {
    const json = (await gunzipAsync(packed, { maxOutputLength: RUN_PROOF_LIMITS.maxUnpackedBytes })).toString("utf8");
    const proof: unknown = JSON.parse(json);
    const snapshot = await this.repository.snapshotOf(row.contentHash);
    // Снимок больше потолка воркер всё равно отклонил бы, а Redis хранил бы лишние мегабайты.
    const attach = snapshot !== null && Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= REPLAY_SNAPSHOT_MAX_BYTES;
    return {
      runId: row.runId,
      proof,
      contentSnapshot: attach ? snapshot : null,
      claimed: { survivalSec: row.survivalSec ?? 0, level: row.level ?? 0, enemiesKilled: row.enemiesKilled ?? 0 },
    };
  }

  // -- проход --------------------------------------------------------------------------------

  private async harvest(): Promise<number> {
    let taken = 0;
    for (const job of await this.queue.finished(BATCH)) {
      try {
        if (await this.take(job)) taken += 1;
      } catch (error: unknown) {
        // Задание остаётся в очереди — следующий проход попробует снова.
        this.note("replay_harvest_failed", { jobId: job.jobId, reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" }, "warn");
      }
    }
    return taken;
  }

  /** Разобрать одно выполненное задание: исход — в забег, задание — из очереди. */
  private async take(job: FinishedReplayJob): Promise<boolean> {
    const id = parseJobId(job.jobId);
    const row = id === null ? null : await this.repository.find(id.runId);
    if (id === null || row === null) {
      await this.queue.remove(job.jobId);
      return false;
    }
    const applied = await this.apply(row, id.attempt, outcomeOf(job));
    await this.queue.remove(job.jobId);
    return applied;
  }

  private async queueDue(): Promise<number> {
    let queued = 0;
    for (const due of await this.repository.dueForQueue(BATCH)) {
      if (await this.enqueue(due.runId, false)) queued += 1;
    }
    return queued;
  }

  /**
   * Поставлены давно, а исхода нет: задание могло пропасть (Redis очищен) или стоять в
   * очереди за другими. Тот же идентификатор в очереди — не новое задание, поэтому постановку
   * просто повторяем; воркер молчит дольше срока — `timeout`, наша сторона.
   */
  private async requeueStale(): Promise<number> {
    const now = this.environment.now();
    let requeued = 0;
    for (const due of await this.repository.staleQueued(new Date(now.getTime() - REPLAY_REQUEUE_MINUTES * MINUTE_MS), BATCH)) {
      if (due.queuedAt === null) continue;
      const row = await this.repository.find(due.runId);
      if (row === null) continue;
      if (now.getTime() - due.queuedAt.getTime() >= REPLAY_SILENT_HOURS * HOUR_MS) {
        const reason = `воркер не ответил за ${String(REPLAY_SILENT_HOURS)} ч`;
        if (await this.apply(row, due.attempt, { verdict: "timeout", reason, divergedTick: null, replayed: null, durationMs: 0 })) await this.queue.remove(jobIdOf(due.runId, due.attempt));
        continue;
      }
      // Срок отодвигается условно: из нескольких реплик ставит одна.
      if (!(await this.repository.requeue(due.runId, due.queuedAt, now))) continue;
      const stored = await this.proofs.find(due.runId);
      if (stored === null) continue;
      await this.submit(row, due.attempt, stored.proof, false, now);
      requeued += 1;
    }
    return requeued;
  }

  /** Записи нет столько часов после конца забега — `no_proof`. */
  private async expireWithoutProof(): Promise<number> {
    const before = new Date(this.environment.now().getTime() - REPLAY_NO_PROOF_HOURS * HOUR_MS);
    let expired = 0;
    for (const runId of await this.repository.withoutProof(before, BATCH)) {
      const row = await this.repository.find(runId);
      if (row !== null && (await this.apply(row, row.replayAttempt, { verdict: "no_proof", reason: null, divergedTick: null, replayed: null, durationMs: 0 }))) expired += 1;
    }
    return expired;
  }

  // -- исход ---------------------------------------------------------------------------------

  /** Положить исход в забег. `false` — исход уже снят или относится к прошлой попытке: ничего не менялось. */
  private async apply(row: ReplayRunRow, attempt: number, outcome: Outcome): Promise<boolean> {
    const at = this.environment.now();
    const effect = effectOf(outcome.verdict, { verdict: row.verdict, required: row.replayRequired, mismatchVerdict: mismatchVerdictOf(this.settings.get(SETTINGS.replayMismatchVerdict)) });
    const settled = await this.repository.settle({
      runId: row.runId,
      attempt,
      outcome: effect.replayVerdict,
      divergedTick: outcome.divergedTick,
      at,
      result: { reason: outcome.reason, replayed: outcome.replayed, durationMs: outcome.durationMs },
      verdict: effect.verdict,
      reason: effect.reason,
      unrank: effect.unrank,
      keepProofUntil: effect.keepProofDays === null ? null : new Date(at.getTime() + effect.keepProofDays * DAY_MS),
    });
    if (!settled.applied) {
      this.note("replay_outcome_ignored", { runId: row.runId, attempt, verdict: outcome.verdict });
      return false;
    }
    if (settled.demoted) await this.refreshBoards(row.runId);
    // Совпавшее — норма, и в лог оно идёт только метрикой; остальное — след для разбора с номером забега (в метки он не попадает).
    if (effect.ourSide) this.note("replay_our_side", { runId: row.runId, verdict: effect.replayVerdict, reason: outcome.reason?.slice(0, 200) ?? null }, "warn");
    else if (effect.replayVerdict === "mismatch") this.note("replay_mismatch", { runId: row.runId, divergedTick: outcome.divergedTick, verdict: effect.verdict, unranked: settled.demoted });
    await this.announce(row, effect.replayVerdict, outcome, at);
    return true;
  }

  /** Забег ушёл из рейтинга — доски пересчитываются; упавший Redis не отменяет исход, доску вернёт пересборка. */
  private async refreshBoards(runId: string): Promise<void> {
    try {
      await this.runs.syncBoardsAfterReplay(runId);
    } catch (error: unknown) {
      this.note("replay_boards_failed", { runId, reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" }, "warn");
    }
  }

  /** Событие и метрика: без игрока и без забега в метках; сбой аналитики исход не отменяет. */
  private async announce(row: ReplayRunRow, verdict: ReplayOutcome, outcome: Outcome, at: Date): Promise<void> {
    let clientOs = clientOsOf(null);
    try {
      clientOs = clientOsOf(await this.repository.clientSession(row.accountId, row.finishedAt ?? at));
    } catch (error: unknown) {
      this.note("replay_session_failed", { reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" }, "warn");
    }
    // Метрика `replay_outcome_total{verdict,client_os}`: строкой лога, пока в бэкенде нет Prometheus (docs/22 §5.9).
    this.note("replay_outcome_total", { verdict, client_os: clientOs });
    if (this.sink === null) return;
    try {
      const payload = EVENT_DICTIONARY.run_replayed.payload.parse({ runId: row.runId, verdict, divergedTick: outcome.divergedTick, durationMs: outcome.durationMs, clientOs });
      const stamp = at.toISOString();
      const event: EventRow = {
        eventId: randomUUID(),
        eventType: "run_replayed",
        schemaVersion: EVENT_DICTIONARY.run_replayed.version,
        installId: "server",
        platformUserId: null,
        sessionId: row.runId.slice(0, 64),
        platform: row.accountPlatform,
        appVersion: "server",
        payload,
        occurredAt: stamp,
        receivedAt: stamp,
      };
      await withTimeout(this.sink.write([event]), EVENT_TIMEOUT_MS, "событие повтора");
    } catch (error: unknown) {
      this.note("replay_event_failed", { reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" }, "warn");
    }
  }

  private async step(name: string, run: () => Promise<number>): Promise<number> {
    try {
      return await run();
    } catch (error: unknown) {
      this.note("replay_sweep_step_failed", { step: name, reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" }, "warn");
      return 0;
    }
  }

  private note(event: string, fields: Record<string, unknown>, level?: "warn"): void {
    this.environment.log(JSON.stringify({ module: "runs", event, ...fields }), level);
  }
}

/** Исход воркера из выполненного задания; форма не сошлась или задание упало — `broken`, наша сторона. */
function outcomeOf(job: FinishedReplayJob): Outcome {
  if (job.state === "failed") return { verdict: "broken", reason: `задание упало: ${job.failedReason ?? "причина неизвестна"}`, divergedTick: null, replayed: null, durationMs: 0 };
  const parsed = replayResultSchema.safeParse(job.result);
  if (!parsed.success) return { verdict: "broken", reason: "исход воркера не по форме", divergedTick: null, replayed: null, durationMs: 0 };
  const result: ReplayResult = parsed.data;
  return { verdict: result.verdict, reason: result.reason, divergedTick: result.divergedTick, replayed: result.replayed, durationMs: result.durationMs };
}
