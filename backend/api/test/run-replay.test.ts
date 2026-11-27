import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import { EVENT_DICTIONARY } from "../src/modules/events/event-dictionary.js";
import type { EventRow } from "../src/modules/events/events.repository.js";
import type { EventsSink } from "../src/modules/events/events.sink.js";
import type { AccountRef } from "../src/modules/roles/roles.service.js";
import type { RecordedRun } from "../src/modules/runs/runs-hooks.js";
import type { RunProofsRepository, StoredProof } from "../src/modules/runs/run-proofs.repository.js";
import { RunProofsService } from "../src/modules/runs/run-proofs.service.js";
import { jobIdOf, REPLAY_KEEP_DAYS, type ReplayFacts, type ReplayOutcome, type ReplayState } from "../src/modules/runs/run-replay-rules.js";
import type { DueRun, ReplayRunRow, ResetResult, RunReplayRepository, SettleResult, Settlement, StoredReplay } from "../src/modules/runs/run-replay.repository.js";
import { REPLAY_SNAPSHOT_MAX_BYTES, RunReplayService, type ReplayFactsReader } from "../src/modules/runs/run-replay.service.js";
import type { FinishedReplayJob, ReplayJobPayload, ReplayQueue } from "../src/modules/runs/run-replay.job.js";
import type { RunVerdict } from "../src/modules/runs/run-verdict.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Перепроверка забегов повтором, сервис на памяти (tasks/T-0319): кому ставится
 * повтор, как задание уходит в очередь, что делает с забегом каждый исход и как
 * сервис переживает повторную доставку, гонку двух исходов и молчащего воркера.
 * Базы и Redis нет — те же сценарии на живых — в `run-replay.integration.test.ts`.
 */

const HOUR = 3_600_000;
/** Ключ панели «подозрение»: умолчание у ключа — observe, а тесты о снятии с рейтинга ставят его явно. */
const SUSP_KEY = { [SETTINGS.replayMismatchVerdict.key]: "suspicious" } as const;
const NOW = new Date("2026-11-14T12:00:00.000Z");
const RUN = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";

const proofJson = (runId: string) => ({ schema: "run-proof-v1", runId, seed: 7, contentHash: "abcd1234", result: { ticks: 3600, survivalSec: 60, level: 3, enemiesKilled: 40, checksum: 99 } });
const packed = (runId: string): Uint8Array => gzipSync(Buffer.from(JSON.stringify(proofJson(runId))));

function row(patch: Partial<ReplayRunRow> = {}): ReplayRunRow {
  return {
    runId: RUN,
    accountId: ACCOUNT,
    accountPlatform: "telegram",
    status: "finished",
    finishedAt: new Date(NOW.getTime() - 5 * 60_000),
    contentHash: "abcd1234",
    survivalSec: 61.5,
    level: 3,
    enemiesKilled: 40,
    verdict: "ok",
    verdictReasons: [],
    ranked: true,
    reviewOutcome: null,
    replayVerdict: null,
    replayRequired: false,
    replayAttempt: 0,
    replayQueuedAt: null,
    ...patch,
  };
}

/** База на памяти: те же условные обновления, что у `PrismaRunReplayRepository`. */
class MemoryReplayRepository implements RunReplayRepository {
  readonly rows = new Map<string, ReplayRunRow>();
  readonly proofs = new Map<string, { keepUntil: Date }>();
  readonly results = new Map<string, Pick<Settlement, "divergedTick" | "at" | "result">>();
  readonly snapshots = new Map<string, unknown>();
  session: { os: string; deviceClass: string } | null = { os: "ios", deviceClass: "mobile" };
  settleCalls = 0;

  add(patch: Partial<ReplayRunRow> = {}, proof = true): ReplayRunRow {
    const created = row(patch);
    this.rows.set(created.runId, created);
    if (proof) this.proofs.set(created.runId, { keepUntil: new Date(NOW.getTime() + 7 * 24 * HOUR) });
    return created;
  }

  find(runId: string): Promise<ReplayRunRow | null> {
    const found = this.rows.get(runId);
    return Promise.resolve(found === undefined ? null : { ...found });
  }

  markPending(runId: string, required: boolean): Promise<boolean> {
    const found = this.rows.get(runId);
    if (found === undefined || found.status !== "finished") return Promise.resolve(false);
    if (found.replayVerdict === null) {
      found.replayVerdict = "pending";
      found.replayRequired = required;
      return Promise.resolve(true);
    }
    if (required) found.replayRequired = true;
    return Promise.resolve(false);
  }

  claimQueue(runId: string, at: Date): Promise<number | null> {
    const found = this.rows.get(runId);
    if (found === undefined || found.replayVerdict !== "pending" || found.replayQueuedAt !== null) return Promise.resolve(null);
    found.replayQueuedAt = at;
    return Promise.resolve(found.replayAttempt);
  }

  releaseQueue(runId: string, at: Date): Promise<void> {
    const found = this.rows.get(runId);
    if (found?.replayQueuedAt?.getTime() === at.getTime()) found.replayQueuedAt = null;
    return Promise.resolve();
  }

  dueForQueue(limit: number): Promise<DueRun[]> {
    const due = [...this.rows.values()].filter((found) => found.replayVerdict === "pending" && found.replayQueuedAt === null && this.proofs.has(found.runId));
    due.sort((a, b) => Number(b.replayRequired) - Number(a.replayRequired));
    return Promise.resolve(due.slice(0, limit).map((found) => ({ runId: found.runId, required: found.replayRequired, attempt: found.replayAttempt, queuedAt: null })));
  }

  staleQueued(before: Date, limit: number): Promise<DueRun[]> {
    const stale = [...this.rows.values()].filter((found) => found.replayVerdict === "pending" && found.replayQueuedAt !== null && found.replayQueuedAt.getTime() < before.getTime());
    return Promise.resolve(stale.slice(0, limit).map((found) => ({ runId: found.runId, required: found.replayRequired, attempt: found.replayAttempt, queuedAt: found.replayQueuedAt })));
  }

  withoutProof(before: Date, limit: number): Promise<string[]> {
    const lost = [...this.rows.values()].filter((found) => found.replayVerdict === "pending" && found.finishedAt !== null && found.finishedAt.getTime() < before.getTime() && !this.proofs.has(found.runId));
    return Promise.resolve(lost.slice(0, limit).map((found) => found.runId));
  }

  settle(settlement: Settlement): Promise<SettleResult> {
    this.settleCalls += 1;
    const found = this.rows.get(settlement.runId);
    if (found === undefined || found.replayVerdict !== "pending" || found.replayAttempt !== settlement.attempt) return Promise.resolve({ applied: false, demoted: false });
    found.replayVerdict = settlement.outcome;
    this.results.set(settlement.runId, { divergedTick: settlement.divergedTick, at: settlement.at, result: settlement.result });
    let demoted = false;
    if (settlement.verdict !== null && found.reviewOutcome === null) {
      found.verdict = settlement.verdict;
      if (settlement.reason !== null) found.verdictReasons = [...found.verdictReasons, settlement.reason];
      if (settlement.unrank && found.ranked) {
        found.ranked = false;
        demoted = true;
      }
    }
    const proof = this.proofs.get(settlement.runId);
    if (proof !== undefined && settlement.keepProofUntil !== null && settlement.keepProofUntil.getTime() > proof.keepUntil.getTime()) proof.keepUntil = settlement.keepProofUntil;
    return Promise.resolve({ applied: true, demoted });
  }

  reset(runId: string): Promise<ResetResult> {
    const found = this.rows.get(runId);
    if (found === undefined || found.status !== "finished") return Promise.resolve({ status: "missing" });
    if (found.replayVerdict === "pending") return Promise.resolve({ status: "pending" });
    if (!this.proofs.has(runId)) return Promise.resolve({ status: "no_proof" });
    found.replayVerdict = "pending";
    found.replayQueuedAt = null;
    found.replayAttempt += 1;
    this.results.delete(runId);
    return Promise.resolve({ status: "reset", attempt: found.replayAttempt, required: found.replayRequired });
  }

  outcomesOf(runIds: readonly string[]): Promise<Map<string, StoredReplay>> {
    const out = new Map<string, StoredReplay>();
    for (const runId of runIds) {
      const found = this.rows.get(runId);
      if (found?.replayVerdict == null) continue;
      const stored = this.results.get(runId);
      out.set(runId, {
        verdict: found.replayVerdict,
        required: found.replayRequired,
        divergedTick: stored?.divergedTick ?? null,
        replayedAt: stored?.at ?? null,
        result: stored?.result ?? null,
        claimed: { survivalSec: found.survivalSec ?? 0, level: found.level ?? 0, enemiesKilled: found.enemiesKilled ?? 0 },
        hasProof: this.proofs.has(runId),
      });
    }
    return Promise.resolve(out);
  }

  clientSession(): Promise<{ os: string; deviceClass: string } | null> {
    return Promise.resolve(this.session);
  }

  snapshotOf(contentHash: string): Promise<unknown> {
    return Promise.resolve(this.snapshots.get(contentHash) ?? null);
  }
}

class MemoryProofs implements RunProofsRepository {
  constructor(private readonly repository: MemoryReplayRepository) {}
  ownRun(): Promise<{ contentHash: string } | null> {
    return Promise.resolve(null);
  }
  insert(): Promise<boolean> {
    return Promise.resolve(true);
  }
  find(runId: string): Promise<StoredProof | null> {
    const stored = this.repository.proofs.get(runId);
    return Promise.resolve(stored === undefined ? null : { proof: packed(runId), receivedAt: NOW, keepUntil: stored.keepUntil });
  }
  deleteExpired(): Promise<number> {
    return Promise.resolve(0);
  }
}

interface QueuedJob {
  payload: ReplayJobPayload;
  priority: number;
  state: "waiting" | "completed" | "failed";
  result: unknown;
  failedReason: string | null;
}

class MemoryQueue implements ReplayQueue {
  readonly jobs = new Map<string, QueuedJob>();
  failAdd = false;
  /** сколько раз сервис просил поставить задание (идемпотентные повторы входят) */
  addCalls = 0;

  add(payload: ReplayJobPayload, options: { jobId: string; priority: number }): Promise<void> {
    if (this.failAdd) return Promise.reject(new Error("Redis недоступен"));
    this.addCalls += 1;
    // Как BullMQ: тот же идентификатор второй раз — не новое задание.
    if (!this.jobs.has(options.jobId)) this.jobs.set(options.jobId, { payload, priority: options.priority, state: "waiting", result: null, failedReason: null });
    return Promise.resolve();
  }

  has(jobId: string): Promise<boolean> {
    return Promise.resolve(this.jobs.has(jobId));
  }

  finished(limit: number): Promise<FinishedReplayJob[]> {
    const done: FinishedReplayJob[] = [];
    for (const [jobId, job] of this.jobs) {
      if (job.state === "waiting") continue;
      done.push({ jobId, runId: job.payload.runId, state: job.state, result: job.result, failedReason: job.failedReason });
    }
    return Promise.resolve(done.slice(0, limit));
  }

  remove(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
    return Promise.resolve();
  }

  /** Воркер закончил задание. */
  complete(jobId: string, result: unknown): void {
    const job = this.jobs.get(jobId);
    if (job !== undefined) Object.assign(job, { state: "completed", result });
  }

  fail(jobId: string, reason: string): void {
    const job = this.jobs.get(jobId);
    if (job !== undefined) Object.assign(job, { state: "failed", failedReason: reason });
  }

  get ids(): string[] {
    return [...this.jobs.keys()];
  }
}

const verdictOf = (outcome: ReplayOutcome, patch: Record<string, unknown> = {}) => ({
  runId: RUN,
  verdict: outcome,
  reason: outcome === "match" ? null : "причина",
  divergedTick: outcome === "mismatch" ? 1800 : null,
  replayed: outcome === "match" || outcome === "mismatch" ? { ticks: 3600, survivalSec: 60, level: 3, enemiesKilled: 40, checksum: 99 } : null,
  durationMs: 812,
  ...patch,
});

interface Setup {
  service: RunReplayService;
  repository: MemoryReplayRepository;
  queue: MemoryQueue;
  events: EventRow[];
  logs: string[];
  unranked: string[];
  audits: { action: string; target: string | null; before?: unknown; after?: unknown }[];
  facts: { value: ReplayFacts };
  clock: { now: Date };
  settings: ReturnType<typeof panelSettings>;
}

const ordinary: ReplayFacts = { mode: "endless", cheats: false, verdict: "ok", ranked: true, boardPlace: null, seasonPlace: null, seasonDivision: null, lootRarity: null, rubezhCleared: false };

function setup(initial: Record<string, string | number | boolean> = {}): Setup {
  const repository = new MemoryReplayRepository();
  const queue = new MemoryQueue();
  const events: EventRow[] = [];
  const logs: string[] = [];
  const unranked: string[] = [];
  const audits: Setup["audits"] = [];
  const facts = { value: ordinary };
  const clock = { now: NOW };
  const settings = panelSettings(initial);
  const sink: EventsSink = {
    write: (rows) => {
      events.push(...rows);
      return Promise.resolve();
    },
  };
  const reader: ReplayFactsReader = { of: () => Promise.resolve(facts.value) };
  const service = new RunReplayService(
    repository,
    new MemoryProofs(repository),
    queue,
    { syncBoardsAfterReplay: (runId: string) => Promise.resolve(void unranked.push(runId)) },
    reader,
    settings,
    { audit: (entry) => Promise.resolve(void audits.push({ action: entry.action, target: entry.target ?? null, before: entry.before, after: entry.after })), require: () => Promise.resolve() },
    sink,
    { now: () => clock.now, log: (line) => logs.push(line) },
  );
  return { service, repository, queue, events, logs, unranked, audits, facts, clock, settings };
}

const recorded = (patch: Partial<RecordedRun> = {}): RecordedRun => ({
  runId: RUN,
  accountId: ACCOUNT,
  difficulty: "hard",
  mode: "endless",
  outcome: "died",
  survivalSec: 61.5,
  points: 4200,
  level: 3,
  enemiesKilled: 40,
  startingWeaponId: "spark",
  weapons: [],
  boosts: [],
  xpCollected: null,
  counters: null,
  deathCause: null,
  cheats: false,
  continues: 0,
  ranked: true,
  verdict: "ok",
  reasons: [],
  finishedAt: new Date(NOW.getTime() - 5 * 60_000),
  ...patch,
});

const admin: AccountRef = { accountId: "22222222-2222-4222-8222-222222222222", platform: "telegram", platformUserId: "1" };

describe("постановка: кому и когда", () => {
  it("забег из первой сотни — обязательный: строка «ожидает», задание в очереди с высоким приоритетом", async () => {
    const t = setup();
    t.repository.add();
    t.facts.value = { ...ordinary, boardPlace: 87 };

    await t.service.onRecorded(recorded());

    expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "pending", replayRequired: true });
    expect(t.queue.jobs.size).toBe(1);
    const [job] = [...t.queue.jobs.values()];
    expect(job?.priority).toBe(1);
  });

  it("задание — ровно в форме воркера: забег, распакованная запись, снимок, заявленный итог", async () => {
    const t = setup();
    t.repository.add();
    t.facts.value = { ...ordinary, boardPlace: 5 };

    await t.service.onRecorded(recorded());

    const [job] = [...t.queue.jobs.values()];
    expect(job?.payload).toEqual({
      runId: RUN,
      proof: proofJson(RUN),
      contentSnapshot: null,
      claimed: { survivalSec: 61.5, level: 3, enemiesKilled: 40 },
    });
    expect(Object.keys(job?.payload ?? {}).sort()).toEqual(["claimed", "contentSnapshot", "proof", "runId"]);
  });

  it("обычный забег идёт выборкой: при доле 100 % — в очередь с низким приоритетом, при 0 — нет", async () => {
    const all = setup({ [SETTINGS.replaySampleRate.key]: 100 });
    all.repository.add();
    await all.service.onRecorded(recorded());
    expect(all.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "pending", replayRequired: false });
    expect([...all.queue.jobs.values()][0]?.priority).toBeGreaterThan(1);

    const none = setup({ [SETTINGS.replaySampleRate.key]: 0 });
    none.repository.add();
    await none.service.onRecorded(recorded());
    expect(none.repository.rows.get(RUN)?.replayVerdict).toBeNull();
    expect(none.queue.jobs.size).toBe(0);
  });

  it("умолчание выборки — 5 %: из тысячи забегов в очередь попадает примерно пятьдесят", async () => {
    const t = setup();
    for (let index = 0; index < 1000; index += 1) {
      const runId = `run-${String(index).padStart(8, "0")}-aaaa-bbbb-cccc-000000000000`;
      t.repository.add({ runId }, false);
      await t.service.onRecorded(recorded({ runId }));
    }
    const pending = [...t.repository.rows.values()].filter((found) => found.replayVerdict === "pending").length;
    expect(pending).toBeGreaterThan(30);
    expect(pending).toBeLessThan(75);
  });

  it("пролог и забег, которому повтор не нужен, строку не трогают", async () => {
    const t = setup({ [SETTINGS.replaySampleRate.key]: 100 });
    t.repository.add();
    t.facts.value = { ...ordinary, mode: "prologue", boardPlace: 1 };
    await t.service.onRecorded(recorded({ mode: "prologue" }));
    expect(t.repository.rows.get(RUN)?.replayVerdict).toBeNull();
    expect(t.queue.jobs.size).toBe(0);
  });

  it("записи ещё нет — строка «ожидает», задания нет; запись пришла — задание поставлено; вторая доставка задания не множит", async () => {
    const t = setup();
    t.repository.add({}, false);
    t.facts.value = { ...ordinary, rubezhCleared: true };
    await t.service.onRecorded(recorded());
    expect(t.repository.rows.get(RUN)?.replayVerdict).toBe("pending");
    expect(t.queue.jobs.size).toBe(0);

    t.repository.proofs.set(RUN, { keepUntil: new Date(NOW.getTime() + 7 * 24 * HOUR) });
    await t.service.onProofStored(RUN);
    await t.service.onProofStored(RUN);

    expect(t.queue.jobs.size).toBe(1);
  });

  it("запись пришла к забегу, которому повтор не нужен, — ничего не ставится", async () => {
    const t = setup();
    t.repository.add();
    await t.service.onProofStored(RUN);
    expect(t.queue.jobs.size).toBe(0);
  });

  it("одновременные постановки одного забега — одно задание", async () => {
    const t = setup();
    t.repository.add({ replayVerdict: "pending", replayRequired: true });
    await Promise.all([t.service.onProofStored(RUN), t.service.onProofStored(RUN), t.service.sweep()]);
    expect(t.queue.jobs.size).toBe(1);
  });

  it("Redis недоступен при постановке — отметка очереди снята, следующий проход ставит задание", async () => {
    const t = setup();
    t.repository.add({ replayVerdict: "pending", replayRequired: true });
    t.queue.failAdd = true;
    await t.service.onProofStored(RUN);
    expect(t.queue.jobs.size).toBe(0);
    expect(t.repository.rows.get(RUN)?.replayQueuedAt).toBeNull();

    t.queue.failAdd = false;
    await t.service.sweep();
    expect(t.queue.jobs.size).toBe(1);
  });

  it("позже обнаруженная добыча делает забег обязательным: выборочный становится обязательным, уже совпавший — остаётся", async () => {
    const t = setup();
    t.repository.add({ replayVerdict: "pending", replayRequired: false });
    await t.service.require(RUN, "loot");
    expect(t.repository.rows.get(RUN)?.replayRequired).toBe(true);
    expect([...t.queue.jobs.values()][0]?.priority).toBe(1);
  });

  it("добыча у забега без выборки заводит его в очередь с нуля", async () => {
    const t = setup();
    t.repository.add();
    await t.service.require(RUN, "loot");
    expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "pending", replayRequired: true });
    expect(t.queue.jobs.size).toBe(1);
  });

  it("снимок контента по хэшу записи — в задании; нет такой версии — `null`; больше потолка — `null`", async () => {
    const withSnapshot = setup();
    withSnapshot.repository.add({ replayVerdict: "pending", replayRequired: true });
    withSnapshot.repository.snapshots.set("abcd1234", { schemaVersion: 1, enemies: [] });
    await withSnapshot.service.onProofStored(RUN);
    expect([...withSnapshot.queue.jobs.values()][0]?.payload.contentSnapshot).toEqual({ schemaVersion: 1, enemies: [] });

    const without = setup();
    without.repository.add({ replayVerdict: "pending", replayRequired: true });
    await without.service.onProofStored(RUN);
    expect([...without.queue.jobs.values()][0]?.payload.contentSnapshot).toBeNull();

    const huge = setup();
    huge.repository.add({ replayVerdict: "pending", replayRequired: true });
    huge.repository.snapshots.set("abcd1234", { blob: "x".repeat(REPLAY_SNAPSHOT_MAX_BYTES) });
    await huge.service.onProofStored(RUN);
    expect([...huge.queue.jobs.values()][0]?.payload.contentSnapshot).toBeNull();
  });
});

describe("исход: что сервер делает с забегом", () => {
  async function queued(setupOptions: Record<string, string | number | boolean> = {}, patch: Partial<ReplayRunRow> = {}) {
    const t = setup(setupOptions);
    t.repository.add({ replayVerdict: "pending", replayRequired: true, ...patch });
    await t.service.onProofStored(RUN);
    const [jobId] = t.queue.ids;
    if (jobId === undefined) throw new Error("задание не поставлено");
    return { t, jobId };
  }

  it("match — вердикт и рейтинг прежние, запись хранится 180 дней, задание убрано из очереди", async () => {
    const { t, jobId } = await queued();
    t.queue.complete(jobId, verdictOf("match"));

    await t.service.sweep();

    expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "match", verdict: "ok", ranked: true });
    expect(t.repository.proofs.get(RUN)?.keepUntil.getTime()).toBe(NOW.getTime() + REPLAY_KEEP_DAYS * 24 * HOUR);
    expect(t.unranked).toEqual([]);
    expect(t.queue.jobs.size).toBe(0);
    expect(t.repository.results.get(RUN)?.result).toMatchObject({ durationMs: 812 });
  });

  it("match у выборочного забега — запись живёт как жила", async () => {
    const { t, jobId } = await queued({}, { replayRequired: false });
    t.queue.complete(jobId, verdictOf("match"));
    await t.service.sweep();
    expect(t.repository.proofs.get(RUN)?.keepUntil.getTime()).toBe(NOW.getTime() + 7 * 24 * HOUR);
  });

  it("умолчание ключа replay.mismatch-verdict — observe: сначала меряем расхождения, а не наказываем", () => {
    expect(SETTINGS.replayMismatchVerdict.fallback).toBe("observe");
    for (const value of ["observe", "suspicious", "rejected"]) expect(SETTINGS.replayMismatchVerdict.schema.safeParse(value).success).toBe(true);
    expect(SETTINGS.replayMismatchVerdict.schema.safeParse("banned").success).toBe(false);
  });

  it("observe (умолчание) — расхождение только записано: исход, тик, запись 180 дней и событие; вердикт, причины, рейтинг и доски прежние", async () => {
    const { t, jobId } = await queued();
    t.queue.complete(jobId, verdictOf("mismatch"));

    await t.service.sweep();

    expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "mismatch", verdict: "ok", verdictReasons: [], ranked: true });
    expect(t.repository.results.get(RUN)).toMatchObject({ divergedTick: 1800, at: NOW });
    expect(t.unranked).toEqual([]);
    expect(t.repository.proofs.get(RUN)?.keepUntil.getTime()).toBe(NOW.getTime() + REPLAY_KEEP_DAYS * 24 * HOUR);
    expect(t.events.map((event) => event.payload)).toEqual([{ runId: RUN, verdict: "mismatch", divergedTick: 1800, durationMs: 812, clientOs: "ios" }]);
    expect(t.logs.some((line) => line.includes("replay_outcome_total") && line.includes('"verdict":"mismatch"'))).toBe(true);
    // Строка в разборе осталась: расхождение видно по исходу, а не по вердикту.
    expect((await t.service.outcomes([RUN])).get(RUN)).toEqual({ verdict: "mismatch", divergedTick: 1800 });
  });

  it("observe не трогает и прежнее подозрение с отказом: ни строже, ни мягче", async () => {
    for (const verdict of ["suspicious", "rejected"] as const) {
      const { t, jobId } = await queued({}, { verdict, ranked: false, verdictReasons: ["manual"] });
      t.queue.complete(jobId, verdictOf("mismatch"));
      await t.service.sweep();
      expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "mismatch", verdict, ranked: false, verdictReasons: ["manual"] });
      expect(t.unranked).toEqual([]);
    }
  });

  it("переключение ключа из панели действует на следующие исходы: прежний остался наблюдением, новый — подозрение", async () => {
    const other = "9c2f0b61-3d1a-4f0e-8a77-0b1c2d3e4f50";
    const t = setup();
    t.repository.add({ replayVerdict: "pending", replayRequired: true });
    t.repository.add({ runId: other, replayVerdict: "pending", replayRequired: true });
    await t.service.onProofStored(RUN);
    await t.service.onProofStored(other);
    const [first, second] = [jobIdOf(RUN, 0), jobIdOf(other, 0)];

    t.queue.complete(first, verdictOf("mismatch"));
    await t.service.sweep();
    expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "mismatch", verdict: "ok", ranked: true });

    t.settings.set(SETTINGS.replayMismatchVerdict.key, "suspicious");
    t.queue.complete(second, verdictOf("mismatch", { runId: other }));
    await t.service.sweep();

    expect(t.repository.rows.get(other)).toMatchObject({ replayVerdict: "mismatch", verdict: "suspicious", verdictReasons: ["replay_mismatch"], ranked: false });
    expect(t.repository.rows.get(RUN)).toMatchObject({ verdict: "ok", ranked: true });
    expect(t.unranked).toEqual([other]);
  });

  it("mismatch — подозрение с причиной replay_mismatch, забег ушёл из рейтинга, доски пересчитаны, тик записан", async () => {
    const { t, jobId } = await queued(SUSP_KEY);
    t.queue.complete(jobId, verdictOf("mismatch"));

    await t.service.sweep();

    expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "mismatch", verdict: "suspicious", verdictReasons: ["replay_mismatch"], ranked: false });
    expect(t.repository.results.get(RUN)).toMatchObject({ divergedTick: 1800, at: NOW });
    expect(t.unranked).toEqual([RUN]);
    expect(t.repository.proofs.get(RUN)?.keepUntil.getTime()).toBe(NOW.getTime() + REPLAY_KEEP_DAYS * 24 * HOUR);
  });

  it("ключ replay.mismatch-verdict = rejected — отказ", async () => {
    const { t, jobId } = await queued({ [SETTINGS.replayMismatchVerdict.key]: "rejected" });
    t.queue.complete(jobId, verdictOf("mismatch"));
    await t.service.sweep();
    expect(t.repository.rows.get(RUN)).toMatchObject({ verdict: "rejected", ranked: false });
  });

  it("повторное расхождение после «Повторить снова» — причина replay_mismatch в забеге одна", async () => {
    const { t, jobId } = await queued(SUSP_KEY);
    t.queue.complete(jobId, verdictOf("mismatch"));
    await t.service.sweep();
    expect(t.repository.rows.get(RUN)).toMatchObject({ verdict: "suspicious", verdictReasons: ["replay_mismatch"], ranked: false });

    await t.service.repeat(admin, RUN);
    t.queue.complete(jobIdOf(RUN, 1), verdictOf("mismatch"));
    await t.service.sweep();

    expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "mismatch", verdict: "suspicious", verdictReasons: ["replay_mismatch"], ranked: false });
    // Из рейтинга забег ушёл в первый раз и во второй раз доски не пересчитываются.
    expect(t.unranked).toEqual([RUN]);
  });

  it("отказ, поставленный раньше, подозрением не смягчается", async () => {
    const { t, jobId } = await queued(SUSP_KEY, { verdict: "rejected", ranked: false });
    t.queue.complete(jobId, verdictOf("mismatch"));
    await t.service.sweep();
    expect(t.repository.rows.get(RUN)?.verdict).toBe("rejected");
    expect(t.unranked).toEqual([]);
  });

  it("решение модератора сильнее: исход записан, но вердикт, рейтинг и доски не тронуты", async () => {
    const { t, jobId } = await queued(SUSP_KEY, { reviewOutcome: "honest" });
    t.queue.complete(jobId, verdictOf("mismatch"));
    await t.service.sweep();
    expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "mismatch", verdict: "ok", ranked: true, verdictReasons: [] });
    expect(t.unranked).toEqual([]);
  });

  it.each(["timeout", "broken", "content_mismatch", "not_replayable"] as const)("%s — вердикт прежний, рейтинг прежний, в лог", async (outcome) => {
    const { t, jobId } = await queued();
    t.queue.complete(jobId, verdictOf(outcome));
    await t.service.sweep();
    expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: outcome, verdict: "ok", ranked: true, verdictReasons: [] });
    expect(t.unranked).toEqual([]);
    if (outcome !== "not_replayable") expect(t.logs.some((line) => line.includes("replay_our_side") && line.includes(outcome))).toBe(true);
  });

  it("упавшее задание — «broken» (наша сторона), забег не наказан", async () => {
    const { t, jobId } = await queued();
    t.queue.fail(jobId, "воркер упал");
    await t.service.sweep();
    expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "broken", verdict: "ok", ranked: true });
    expect(t.queue.jobs.size).toBe(0);
  });

  it("исход не по форме — тоже «broken»: чужой результат из Redis не кладётся в базу как есть", async () => {
    const { t, jobId } = await queued();
    t.queue.complete(jobId, { verdict: "банан" });
    await t.service.sweep();
    expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "broken", verdict: "ok" });
  });

  it("два воркера сервера снимают один исход одновременно: эффект один — одно снятие с рейтинга, одно событие", async () => {
    const { t, jobId } = await queued(SUSP_KEY);
    t.queue.complete(jobId, verdictOf("mismatch"));

    await Promise.all([t.service.sweep(), t.service.sweep()]);

    expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "mismatch", verdict: "suspicious", verdictReasons: ["replay_mismatch"], ranked: false });
    expect(t.unranked).toEqual([RUN]);
    expect(t.events.filter((event) => event.eventType === "run_replayed")).toHaveLength(1);
    expect(t.queue.jobs.size).toBe(0);
  });

  it("исход прошлой попытки (до «Повторить снова») на новую не ложится: задание убрано, забег ждёт новый исход", async () => {
    const { t, jobId } = await queued();
    t.queue.complete(jobId, verdictOf("mismatch"));
    // Модератор нажал «Повторить снова», пока старое задание лежало в очереди нечитанным.
    const row = t.repository.rows.get(RUN);
    if (row === undefined) throw new Error("нет строки");
    row.replayAttempt = 1;

    await t.service.sweep();

    expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "pending", verdict: "ok", ranked: true });
    expect(t.unranked).toEqual([]);
    expect(t.events).toHaveLength(0);
    expect(t.queue.jobs.has(jobId)).toBe(false);
  });

  it("исход для забега, которого уже нет, — задание убрано, ничего не падает", async () => {
    const { t, jobId } = await queued();
    t.repository.rows.delete(RUN);
    t.queue.complete(jobId, verdictOf("match"));
    await expect(t.service.sweep()).resolves.toBeDefined();
    expect(t.queue.jobs.size).toBe(0);
  });
});

describe("тишина: нет записи, молчит воркер", () => {
  it("записи нет 72 часа — исход «no_proof»; 71 час — ещё ждём", async () => {
    const t = setup();
    t.repository.add({ replayVerdict: "pending", replayRequired: true, finishedAt: new Date(NOW.getTime() - 71 * HOUR) }, false);
    await t.service.sweep();
    expect(t.repository.rows.get(RUN)?.replayVerdict).toBe("pending");

    t.clock.now = new Date(NOW.getTime() + 2 * HOUR);
    await t.service.sweep();
    expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "no_proof", verdict: "ok", ranked: true });
  });

  it("no_proof в событии и в метрике — как остальные исходы", async () => {
    const t = setup();
    t.repository.add({ replayVerdict: "pending", finishedAt: new Date(NOW.getTime() - 80 * HOUR) }, false);
    await t.service.sweep();
    expect(t.events.map((event) => event.payload.verdict)).toEqual(["no_proof"]);
    expect(t.logs.some((line) => line.includes("replay_outcome_total") && line.includes('"verdict":"no_proof"'))).toBe(true);
  });

  /** Проход раз в 30 минут, как при молчащем воркере: сколько проходов — столько и сдвигов часов. */
  async function sweepEvery30Minutes(t: Setup, from: Date, hours: number, after?: () => void): Promise<void> {
    for (let step = 1; step <= hours * 2; step += 1) {
      t.clock.now = new Date(from.getTime() + step * 30 * 60_000);
      await t.service.sweep();
      after?.();
    }
  }

  it("запись есть, а воркер молчит 72 часа — «timeout»: наша сторона, вердикт прежний, задание снято с очереди", async () => {
    const t = setup();
    t.repository.add({ replayVerdict: "pending", replayRequired: true });
    await t.service.onProofStored(RUN);
    expect(t.queue.ids).toEqual([jobIdOf(RUN, 0)]);

    // Проход каждые 30 минут: до 71,5 часа ещё ждём, ровно через 72 — «timeout».
    await sweepEvery30Minutes(t, NOW, 71.5);
    expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "pending", replayQueuedAt: NOW });
    expect(t.queue.ids).toEqual([jobIdOf(RUN, 0)]);

    t.clock.now = new Date(NOW.getTime() + 72 * HOUR);
    await t.service.sweep();

    expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "timeout", verdict: "ok", ranked: true });
    expect(t.queue.jobs.size).toBe(0);
    expect(t.queue.addCalls).toBe(1);
    expect(t.events.map((event) => event.payload.verdict)).toEqual(["timeout"]);
  });

  it("молчащий воркер и проход каждую минуту — тот же срок: отметка постановки не сдвигается", async () => {
    const t = setup();
    t.repository.add({ replayVerdict: "pending", replayRequired: false });
    await t.service.onProofStored(RUN);
    for (let minute = 1; minute <= 60; minute += 1) {
      t.clock.now = new Date(NOW.getTime() + minute * 60_000);
      await t.service.sweep();
    }
    expect(t.repository.rows.get(RUN)?.replayQueuedAt).toEqual(NOW);

    t.clock.now = new Date(NOW.getTime() + 72 * HOUR - 60_000);
    await t.service.sweep();
    expect(t.repository.rows.get(RUN)?.replayVerdict).toBe("pending");
    t.clock.now = new Date(NOW.getTime() + 72 * HOUR);
    await t.service.sweep();
    expect(t.repository.rows.get(RUN)?.replayVerdict).toBe("timeout");
  });

  it("запись есть, воркер молчит, а задание то и дело пропадает из очереди — «timeout» всё равно через 72 часа от первой постановки", async () => {
    const t = setup();
    t.repository.add({ replayVerdict: "pending", replayRequired: true });
    await t.service.onProofStored(RUN);

    await sweepEvery30Minutes(t, NOW, 72, () => t.queue.jobs.clear());

    expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "timeout", verdict: "ok", ranked: true });
    // Потерянное задание ставилось заново на каждом проходе, но срок от этого не уезжал.
    expect(t.queue.addCalls).toBeGreaterThan(100);
  });

  it("запись есть, а воркер молчит 72 часа от постановки — «timeout» и без прохода посреди срока", async () => {
    const t = setup();
    t.repository.add({ replayVerdict: "pending", replayRequired: true, replayQueuedAt: new Date(NOW.getTime() - 73 * HOUR) });
    await t.service.sweep();
    expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "timeout", verdict: "ok", ranked: true });
  });

  it("задание потеряно (Redis очищен) — через полчаса ставится заново под тем же идентификатором, срок прежний", async () => {
    const t = setup();
    const queuedAt = new Date(NOW.getTime() - 40 * 60_000);
    t.repository.add({ replayVerdict: "pending", replayRequired: true, replayQueuedAt: queuedAt });
    await t.service.sweep();
    expect(t.queue.ids).toEqual([jobIdOf(RUN, 0)]);
    expect(t.repository.rows.get(RUN)?.replayQueuedAt).toEqual(queuedAt);
    expect(t.queue.addCalls).toBe(1);

    // Следующий проход задание уже видит и второй раз не ставит.
    t.clock.now = new Date(NOW.getTime() + 60_000);
    await t.service.sweep();
    expect(t.queue.addCalls).toBe(1);
  });

  it("задание ещё стоит в очереди (воркер занят) — второго не ставим и срок не сдвигаем", async () => {
    const t = setup();
    t.repository.add({ replayVerdict: "pending", replayRequired: true });
    await t.service.onProofStored(RUN);
    expect(t.repository.rows.get(RUN)?.replayQueuedAt).toEqual(NOW);

    t.clock.now = new Date(NOW.getTime() + 40 * 60_000);
    await t.service.sweep();

    expect(t.queue.jobs.size).toBe(1);
    expect(t.queue.addCalls).toBe(1);
    expect(t.repository.rows.get(RUN)?.replayQueuedAt).toEqual(NOW);
  });

  it("Redis недоступен на повторной постановке — срок не сбрасывается, следующий проход ставит снова", async () => {
    const t = setup();
    t.repository.add({ replayVerdict: "pending", replayRequired: true, replayQueuedAt: new Date(NOW.getTime() - 40 * 60_000) });
    t.queue.failAdd = true;
    await t.service.sweep();
    expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "pending", replayQueuedAt: new Date(NOW.getTime() - 40 * 60_000) });
    expect(t.queue.jobs.size).toBe(0);

    t.queue.failAdd = false;
    t.clock.now = new Date(NOW.getTime() + 60_000);
    await t.service.sweep();
    expect(t.queue.ids).toEqual([jobIdOf(RUN, 0)]);
  });

  it("«Повторить снова» заводит срок молчания заново: новая попытка не наследует 72 часа прежней", async () => {
    const t = setup();
    t.repository.add({ replayVerdict: "pending", replayRequired: true });
    await t.service.onProofStored(RUN);
    await sweepEvery30Minutes(t, NOW, 72);
    expect(t.repository.rows.get(RUN)?.replayVerdict).toBe("timeout");

    await t.service.repeat(admin, RUN);
    expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "pending", replayAttempt: 1, replayQueuedAt: t.clock.now });
    t.clock.now = new Date(t.clock.now.getTime() + 60 * 60_000);
    await t.service.sweep();
    expect(t.repository.rows.get(RUN)?.replayVerdict).toBe("pending");
  });
});

describe("наблюдение: событие и метрика", () => {
  it("исход — событие run_replayed по словарю: забег, вердикт, тик, длительность, площадка клиента", async () => {
    const t = setup();
    t.repository.add({ replayVerdict: "pending", replayRequired: true });
    await t.service.onProofStored(RUN);
    t.queue.complete(t.queue.ids[0] ?? "", verdictOf("mismatch"));

    await t.service.sweep();

    const [event] = t.events;
    expect(event).toMatchObject({ eventType: "run_replayed", installId: "server", appVersion: "server", schemaVersion: EVENT_DICTIONARY.run_replayed.version });
    expect(event?.payload).toEqual({ runId: RUN, verdict: "mismatch", divergedTick: 1800, durationMs: 812, clientOs: "ios" });
    expect(EVENT_DICTIONARY.run_replayed.payload.safeParse(event?.payload).success).toBe(true);
    // В нагрузке нет ни аккаунта игрока, ни причины в виде текста воркера.
    expect(JSON.stringify(event?.payload)).not.toContain(ACCOUNT);
  });

  it("метрика replay_outcome_total — строка лога с вердиктом и площадкой, без забега и игрока", async () => {
    const t = setup();
    t.repository.add({ replayVerdict: "pending", replayRequired: true });
    t.repository.session = { os: "android", deviceClass: "mobile" };
    await t.service.onProofStored(RUN);
    t.queue.complete(t.queue.ids[0] ?? "", verdictOf("match"));

    await t.service.sweep();

    const line = t.logs.find((entry) => entry.includes("replay_outcome_total"));
    expect(line).toBeDefined();
    expect(JSON.parse(line ?? "{}")).toMatchObject({ event: "replay_outcome_total", verdict: "match", client_os: "android" });
    expect(line).not.toContain(RUN);
    expect(line).not.toContain(ACCOUNT);
  });

  it("нет сессии игрока — площадка «unknown»", async () => {
    const t = setup();
    t.repository.add({ replayVerdict: "pending", replayRequired: true });
    t.repository.session = null;
    await t.service.onProofStored(RUN);
    t.queue.complete(t.queue.ids[0] ?? "", verdictOf("match"));
    await t.service.sweep();
    expect(t.events[0]?.payload.clientOs).toBe("unknown");
  });

  it("писатель событий упал — исход всё равно записан", async () => {
    const t = setup();
    const failing = new RunReplayService(
      t.repository,
      new MemoryProofs(t.repository),
      t.queue,
      { syncBoardsAfterReplay: () => Promise.resolve() },
      { of: () => Promise.resolve(ordinary) },
      t.settings,
      { audit: () => Promise.resolve(), require: () => Promise.resolve() },
      { write: () => Promise.reject(new Error("очередь событий упала")) },
      { now: () => NOW, log: () => undefined },
    );
    t.repository.add({ replayVerdict: "pending", replayRequired: true });
    await failing.onProofStored(RUN);
    t.queue.complete(t.queue.ids[0] ?? "", verdictOf("match"));
    await expect(failing.sweep()).resolves.toBeDefined();
    expect(t.repository.rows.get(RUN)?.replayVerdict).toBe("match");
  });
});

describe("«Повторить снова»", () => {
  it("после исхода — снова «ожидает», новое задание под другим идентификатором, строка аудита с прежним исходом", async () => {
    const t = setup();
    t.repository.add({ replayVerdict: "pending", replayRequired: true });
    await t.service.onProofStored(RUN);
    t.queue.complete(t.queue.ids[0] ?? "", verdictOf("timeout"));
    await t.service.sweep();
    expect(t.repository.rows.get(RUN)?.replayVerdict).toBe("timeout");

    t.clock.now = new Date(NOW.getTime() + 1000);
    const view = await t.service.repeat(admin, RUN);

    expect(view.verdict).toBe("pending");
    expect(t.queue.jobs.size).toBe(1);
    // Модератор ждёт ответ — приоритет выше выборки.
    expect([...t.queue.jobs.values()][0]?.priority).toBe(1);
    expect(t.audits).toEqual([{ action: "players.run.replay", target: ACCOUNT, before: { replayVerdict: "timeout", divergedTick: null }, after: { runId: RUN } }]);
  });

  it("повторить забег, который никогда не повторялся, можно: приоритет высокий, обязательности это не добавляет", async () => {
    const t = setup();
    t.repository.add();
    const view = await t.service.repeat(admin, RUN);
    expect(view.verdict).toBe("pending");
    expect(t.repository.rows.get(RUN)?.replayRequired).toBe(false);
    expect([...t.queue.jobs.values()][0]?.priority).toBe(1);
  });

  it("повтор уже идёт — отказ 409, второго задания и второй строки аудита нет", async () => {
    const t = setup();
    t.repository.add({ replayVerdict: "pending", replayRequired: true });
    await t.service.onProofStored(RUN);

    await expect(t.service.repeat(admin, RUN)).rejects.toMatchObject({ status: 409 });
    expect(t.queue.jobs.size).toBe(1);
    expect(t.audits).toEqual([]);
  });

  it("записи нет (истекла) — отказ 409 с понятной причиной; забега нет — 404", async () => {
    const t = setup();
    t.repository.add({ replayVerdict: "mismatch" }, false);
    const refused = await t.service.repeat(admin, RUN).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DomainError);
    expect(refused).toMatchObject({ status: 409, code: "run_replay_no_proof" });

    await expect(t.service.repeat(admin, "no-such-run-0000")).rejects.toMatchObject({ status: 404 });
    expect(t.audits).toEqual([]);
  });

  it("новый исход после повтора снова применяется: был «timeout», стал «mismatch»", async () => {
    const t = setup(SUSP_KEY);
    t.repository.add({ replayVerdict: "timeout", replayRequired: true });
    await t.service.repeat(admin, RUN);
    t.queue.complete(t.queue.ids[0] ?? "", verdictOf("mismatch"));
    await t.service.sweep();
    expect(t.repository.rows.get(RUN)).toMatchObject({ replayVerdict: "mismatch", verdict: "suspicious", ranked: false });
  });
});

describe("чтение для панели", () => {
  it("исход, тик, таблица «заявлено / повтор» и признак «можно повторить»", async () => {
    const t = setup();
    t.repository.add({ replayVerdict: "pending", replayRequired: true });
    await t.service.onProofStored(RUN);
    t.queue.complete(t.queue.ids[0] ?? "", verdictOf("mismatch", { replayed: { ticks: 3600, survivalSec: 55, level: 3, enemiesKilled: 31, checksum: 5 } }));
    await t.service.sweep();

    const view = await t.service.view(RUN);

    expect(view).toMatchObject({
      verdict: "mismatch",
      required: true,
      divergedTick: 1800,
      reason: "причина",
      claimed: { survivalSec: 61.5, level: 3, enemiesKilled: 40 },
      replayed: { ticks: 3600, survivalSec: 55, level: 3, enemiesKilled: 31, checksum: 5 },
      canRepeat: true,
    });
  });

  it("забег, которому повтор не нужен, — исход пуст, повторить можно, пока запись жива", async () => {
    const t = setup();
    t.repository.add();
    expect(await t.service.view(RUN)).toMatchObject({ verdict: null, required: false, replayed: null, canRepeat: true });
    t.repository.proofs.delete(RUN);
    expect(await t.service.view(RUN)).toMatchObject({ canRepeat: false });
  });

  it("повтор идёт — повторить нельзя", async () => {
    const t = setup();
    t.repository.add({ replayVerdict: "pending" });
    expect(await t.service.view(RUN)).toMatchObject({ verdict: "pending", canRepeat: false });
  });

  it("очередь разбора: исходы пачкой по номерам забегов", async () => {
    const t = setup();
    t.repository.add({ replayVerdict: "mismatch" });
    t.repository.results.set(RUN, { divergedTick: 900, at: NOW, result: { reason: null, replayed: null, durationMs: 1 } });
    const outcomes = await t.service.outcomes([RUN, "other-run-0000"]);
    expect(outcomes.get(RUN)).toEqual({ verdict: "mismatch", divergedTick: 900 });
    expect(outcomes.has("other-run-0000")).toBe(false);
  });
});

describe("страховка слушателя", () => {
  it("сбой базы при решении не роняет приём забега: слушатель ловит ошибку, ответ игроку уже ушёл", async () => {
    const t = setup();
    vi.spyOn(t.repository, "markPending").mockRejectedValueOnce(new Error("база недоступна"));
    t.repository.add();
    t.facts.value = { ...ordinary, boardPlace: 1 };
    await expect(t.service.onRecorded(recorded())).rejects.toThrow("база недоступна");
    // Следующий забег проходит как ни в чём не бывало.
    await expect(t.service.onRecorded(recorded())).resolves.toBeUndefined();
    expect(t.repository.rows.get(RUN)?.replayVerdict).toBe("pending");
  });
});

/** Типы исходов и состояний — те же, что у правил: сервис их не расширяет. */
const _states: ReplayState[] = ["pending", "match", "mismatch", "content_mismatch", "not_replayable", "broken", "timeout", "no_proof"];
const _verdicts: RunVerdict[] = ["ok", "suspicious", "rejected"];
void _states;
void _verdicts;

describe("приём записи: постановка повтора не задерживает ответ", () => {
  const proofBase64 = (runId: string): string =>
    gzipSync(
      Buffer.from(
        JSON.stringify({
          schema: "run-proof-v1",
          runId,
          seed: 123456,
          mapId: "field",
          difficultyId: "hard",
          mode: "endless",
          startingWeaponId: "spark",
          contentHash: "abcd1234",
          unitScale: 1,
          loadout: { modifiers: { damage: 0.1 }, boosts: [], accountLevel: 5 },
          input: { encoding: "rle-v1", ticks: 3600, data: "AAEC", truncated: false },
          choices: [[600, "might"]],
          continues: [],
          checkpoints: [[3600, 12345]],
          result: { ticks: 3600, survivalSec: 60, level: 3, enemiesKilled: 40, deathCause: "swarm_rat", checksum: 99 },
        }),
      ),
    ).toString("base64");

  /** Хранилище записей на памяти: забег свой, вставка проходит. */
  function intake(): RunProofsService {
    const repository: RunProofsRepository = {
      ownRun: () => Promise.resolve({ contentHash: "abcd1234" }),
      insert: () => Promise.resolve(true),
      find: () => Promise.resolve(null),
      deleteExpired: () => Promise.resolve(0),
    };
    return new RunProofsService(repository);
  }

  it("ответ приёма уходит, не дожидаясь слушателя: медленная постановка (очередь, база) игроку не слышна", async () => {
    const proofs = intake();
    let release: () => void = () => undefined;
    let finished = false;
    proofs.onStored("slow", async () => {
      await new Promise<void>((resolve) => (release = resolve));
      finished = true;
    });

    const receipt = await proofs.receive(ACCOUNT, RUN, proofBase64(RUN));

    expect(receipt.status).toBe("stored");
    expect(finished).toBe(false);
    release();
    await proofs.idle();
    expect(finished).toBe(true);
  });

  it("упавший слушатель запись не отменяет и необработанной ошибки не оставляет", async () => {
    const proofs = intake();
    const seen: string[] = [];
    proofs.onStored("broken", () => Promise.reject(new Error("очередь недоступна")));
    proofs.onStored("next", (runId) => Promise.resolve(void seen.push(runId)));

    await expect(proofs.receive(ACCOUNT, RUN, proofBase64(RUN))).resolves.toMatchObject({ status: "stored" });
    await proofs.idle();

    // Следующий слушатель после упавшего всё равно позван.
    expect(seen).toEqual([RUN]);
  });

  it("запись не прошла проверку — слушателей никто не зовёт", async () => {
    const proofs = intake();
    const seen: string[] = [];
    proofs.onStored("replay", (runId) => Promise.resolve(void seen.push(runId)));

    await expect(proofs.receive(ACCOUNT, RUN, "не-base64!")).rejects.toMatchObject({ status: 422 });
    await proofs.idle();

    expect(seen).toEqual([]);
  });
});
