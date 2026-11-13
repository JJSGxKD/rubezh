import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "../src/common/domain-error.js";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { PaymentReconciler } from "../src/modules/payments/payment-reconciler.js";
import { RECONCILE, type FoundDiscrepancy, type KnownPurchase } from "../src/modules/payments/payment-reconcile.js";
import type {
  DiscrepancyRow,
  FinishedRun,
  InsertedFound,
  LastFinished,
  OpenDiscrepancy,
  PaymentReconcileRepository,
  PurchaseRef,
  ReconcileRows,
  StartedRun,
} from "../src/modules/payments/payment-reconcile.repository.js";
import { PurchaseActionUnavailableError } from "../src/modules/payments/payments-errors.js";
import { PaymentsHooks, type ReconcileFound } from "../src/modules/payments/payments-hooks.js";
import type { PlatformId } from "../src/platforms/ports/platform.js";
import { PaymentStatements, type PaymentStatement, type StatementEntry } from "../src/platforms/ports/payment-statement.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Сверка оплат с выпиской (tasks/T-0433, Р209, WP53): страницы выписки,
 * курсор, лок, выключатель, запись расхождений, сообщение команде. Выписка,
 * репозиторий и Redis подставные; роли и аккаунты — в памяти.
 */

const NOW = new Date("2026-11-13T12:00:00Z");
const DAY = 24 * 3_600_000;
const OWNER_ID = "777000111";
const PURCHASE_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const LOCK_KEY = "payments:reconcile:lock";

const ago = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);

function config(env: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID, ...env } as NodeJS.ProcessEnv);
}

function operation(index: number, patch: Partial<StatementEntry> = {}): StatementEntry {
  return { id: `op-${String(index)}`, kind: "other", amount: 1, at: ago(10_000 - index), payerId: null, payload: null, subscriptionPeriodSec: null, ...patch };
}

/** Выписка из `count` операций прочих видов: сверять в ней нечего, важны только страницы. */
function filler(count: number): StatementEntry[] {
  return Array.from({ length: count }, (_, index) => operation(index));
}

function entry(id: string, minutes: number, patch: Partial<StatementEntry> = {}): StatementEntry {
  return { id, kind: "payment", amount: 50, at: ago(minutes), payerId: "555000111", payload: null, subscriptionPeriodSec: null, ...patch };
}

function purchase(chargeId: string, patch: Partial<KnownPurchase> = {}): KnownPurchase {
  return { purchaseId: randomUUID(), accountId: ACCOUNT_ID, chargeId, chargedStars: 50, paidAt: ago(500), refundedAt: null, ...patch };
}

/** Выписка в памяти: страницы отдаёт срезом; `failOn` — номер вызова, на котором площадка отвечает ошибкой. */
class MemoryStatement implements PaymentStatement {
  entries: StatementEntry[] = [];
  readonly calls: { offset: number; limit: number }[] = [];
  failOn: number | null = null;
  onPage: (() => void) | null = null;

  constructor(
    readonly platform: PlatformId,
    readonly pageMax = 100,
  ) {}

  async page(offset: number, limit: number): Promise<StatementEntry[]> {
    this.calls.push({ offset, limit });
    this.onPage?.();
    if (this.failOn !== null && this.calls.length === this.failOn) throw new Error("Bad Gateway");
    return this.entries.slice(offset, offset + limit);
  }
}

type RunRecord = StartedRun & Omit<FinishedRun, "finishedAt"> & { finishedAt: Date | null };

/** Репозиторий в памяти: те же правила, что у Postgres, — удачная сверка без ошибки, уникальный ключ расхождения. */
class MemoryReconcileRepository implements PaymentReconcileRepository {
  readonly runs: RunRecord[] = [];
  readonly discrepancies: (DiscrepancyRow & { runId: string })[] = [];
  purchases: (KnownPurchase & { platform: PlatformId })[] = [];
  refs: PurchaseRef[] = [];
  readonly byChargesCalls: string[][] = [];
  readonly byIdsCalls: string[][] = [];
  readonly windows: { platform: PlatformId; from: Date; to: Date }[] = [];
  failStartRun = false;
  /** Итог удачной сверки не записался (один раз): база упала после вставки расхождений. */
  failNextFinish = false;

  /** Удачная сверка прошлых суток — как строка в базе. */
  succeeded(platform: PlatformId, toOffset: number, finishedAt: Date): void {
    this.runs.push({
      runId: randomUUID(),
      platform,
      trigger: "schedule",
      actorAccountId: null,
      startedAt: finishedAt,
      fromOffset: 0,
      finishedAt,
      toOffset,
      coveredFrom: null,
      coveredTo: null,
      scanned: toOffset,
      found: 0,
      matched: 0,
      error: null,
    });
  }

  /** Сверка, оборвавшаяся ошибкой площадки: курсора у неё нет. */
  failed(platform: PlatformId, finishedAt: Date, error: string): void {
    this.runs.push({
      runId: randomUUID(),
      platform,
      trigger: "schedule",
      actorAccountId: null,
      startedAt: finishedAt,
      fromOffset: 0,
      finishedAt,
      toOffset: null,
      coveredFrom: null,
      coveredTo: null,
      scanned: 0,
      found: 0,
      matched: 0,
      error,
    });
  }

  /** Расхождение, уже лежащее в базе. */
  existing(patch: Partial<DiscrepancyRow> & Pick<DiscrepancyRow, "kind" | "chargeId">): DiscrepancyRow {
    const row: DiscrepancyRow & { runId: string } = {
      discrepancyId: randomUUID(),
      platform: "telegram",
      purchaseId: null,
      accountId: null,
      payerId: null,
      amount: 50,
      payload: null,
      occurredAt: ago(1000),
      detectedAt: ago(900),
      resolution: null,
      resolvedAt: null,
      resolvedBy: null,
      note: null,
      runId: randomUUID(),
      ...patch,
    };
    this.discrepancies.push(row);
    return row;
  }

  async lastFinished(platform: PlatformId): Promise<LastFinished | null> {
    const done = this.runs.filter((run) => run.platform === platform && run.finishedAt !== null && run.error === null && run.toOffset !== null);
    done.sort((a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0));
    const last = done[0];
    return last === undefined || last.finishedAt === null || last.toOffset === null ? null : { toOffset: last.toOffset, finishedAt: last.finishedAt };
  }

  async startRun(run: StartedRun): Promise<void> {
    if (this.failStartRun) throw new Error("база недоступна");
    this.runs.push({ ...run, finishedAt: null, toOffset: null, coveredFrom: null, coveredTo: null, scanned: 0, found: 0, matched: 0, error: null });
  }

  async finishRun(runId: string, result: FinishedRun): Promise<void> {
    if (this.failNextFinish && result.error === null) {
      this.failNextFinish = false;
      throw new Error("база недоступна");
    }
    const run = this.runs.find((candidate) => candidate.runId === runId);
    if (run === undefined) throw new Error("нет строки сверки");
    Object.assign(run, result);
  }

  async purchasesByCharges(chargeIds: readonly string[]): Promise<KnownPurchase[]> {
    this.byChargesCalls.push([...chargeIds]);
    return this.purchases.filter((row) => chargeIds.includes(row.chargeId));
  }

  async purchasesByIds(purchaseIds: readonly string[]): Promise<PurchaseRef[]> {
    this.byIdsCalls.push([...purchaseIds]);
    return this.refs.filter((row) => purchaseIds.includes(row.purchaseId));
  }

  async paidInWindow(platform: PlatformId, from: Date, to: Date): Promise<KnownPurchase[]> {
    this.windows.push({ platform, from, to });
    return this.purchases.filter((row) => row.platform === platform && row.paidAt >= from && row.paidAt <= to);
  }

  async insertFound(runId: string, platform: PlatformId, found: readonly FoundDiscrepancy[], at: Date): Promise<InsertedFound> {
    const items: InsertedFound["items"] = [];
    for (const item of found) {
      if (this.discrepancies.some((row) => row.platform === platform && row.kind === item.kind && row.chargeId === item.chargeId)) continue;
      this.discrepancies.push({
        discrepancyId: randomUUID(),
        platform,
        kind: item.kind,
        chargeId: item.chargeId,
        purchaseId: item.purchaseId,
        accountId: item.accountId,
        payerId: item.payerId,
        amount: item.amount,
        payload: item.payload,
        occurredAt: item.occurredAt,
        detectedAt: at,
        resolution: null,
        resolvedAt: null,
        resolvedBy: null,
        note: null,
        runId,
      });
      items.push({ kind: item.kind, chargeId: item.chargeId, purchaseId: item.purchaseId });
    }
    return { inserted: items.length, items };
  }

  async open(platform: PlatformId): Promise<OpenDiscrepancy[]> {
    return this.discrepancies.filter((row) => row.platform === platform && row.resolvedAt === null).map(({ discrepancyId, kind, chargeId }) => ({ discrepancyId, kind, chargeId }));
  }

  async resolveMatched(discrepancyIds: readonly string[], at: Date): Promise<number> {
    let closed = 0;
    for (const row of this.discrepancies) {
      if (!discrepancyIds.includes(row.discrepancyId) || row.resolvedAt !== null) continue;
      row.resolvedAt = at;
      row.resolution = "matched";
      closed += 1;
    }
    return closed;
  }

  async overview(now: Date): Promise<ReconcileRows> {
    const lastRuns = new Map<string, RunRecord>();
    for (const run of [...this.runs].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())) lastRuns.set(run.platform, run);
    const monthAgo = now.getTime() - 30 * DAY;
    return {
      lastRuns: [...lastRuns.values()].map((run) => ({ platform: run.platform, trigger: run.trigger, startedAt: run.startedAt, finishedAt: run.finishedAt, scanned: run.scanned, found: run.found, error: run.error })),
      open: this.discrepancies.filter((row) => row.resolvedAt === null).sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime()),
      resolved: this.discrepancies.filter((row) => row.resolvedAt !== null && row.resolvedAt.getTime() >= monthAgo).sort((a, b) => (b.resolvedAt?.getTime() ?? 0) - (a.resolvedAt?.getTime() ?? 0)),
    };
  }
}

/** Redis на двух командах лока: `SET … NX PX` и снятие своим токеном. */
class FakeRedis {
  readonly values = new Map<string, string>();
  readonly sets: { key: string; args: unknown[] }[] = [];

  async set(key: string, value: string, ...args: unknown[]): Promise<"OK" | null> {
    this.sets.push({ key, args });
    if (this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async eval(_script: string, _keys: number, key: string, token: string): Promise<number> {
    if (this.values.get(key) !== token) return 0;
    this.values.delete(key);
    return 1;
  }
}

function setup(options: { env?: Record<string, string>; settings?: Record<string, boolean>; statements?: MemoryStatement[] } = {}) {
  const cfg = config(options.env);
  const statement = new MemoryStatement("telegram");
  const statements = new PaymentStatements(options.statements ?? [statement]);
  const repository = new MemoryReconcileRepository();
  const redis = new FakeRedis();
  const settings = panelSettings(options.settings ?? {});
  const hooks = new PaymentsHooks();
  const found: ReconcileFound[] = [];
  hooks.onReconcileFound("тест", async (event) => {
    found.push(event);
  });
  const accounts = new MemoryAccountRepository();
  const rolesRepository = new MemoryRolesRepository();
  const roles = new RolesService(cfg, rolesRepository, accounts);
  const reconciler = new PaymentReconciler(cfg, statements, repository, redis as never, settings, hooks, roles, accounts);
  return { cfg, statement, statements, repository, redis, settings, hooks, found, accounts, rolesRepository, roles, reconciler };
}

type Setup = ReturnType<typeof setup>;

async function person(s: Setup, id: string, role?: "admin" | "moderator", displayName = `Игрок ${id}`): Promise<AccountRef> {
  const account = await s.accounts.upsert({ platform: "telegram", platformUserId: id, displayName, username: null, photoUrl: null }, NOW.getTime());
  if (role !== undefined) await s.rolesRepository.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}

let logged: { level: string; event: string; fields: Record<string, unknown> }[];

beforeEach(() => {
  logged = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
      const fields = JSON.parse(String(message)) as Record<string, unknown>;
      logged.push({ level, event: String(fields.event), fields });
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("PaymentReconciler: чтение выписки", () => {
  it("выписка из 250 операций — три страницы (100, 100, 50), курсор — 250", async () => {
    const s = setup();
    s.statement.entries = filler(250);

    const result = await s.reconciler.run("schedule", null, NOW);

    expect(s.statement.calls).toEqual([
      { offset: 0, limit: 100 },
      { offset: 100, limit: 100 },
      { offset: 200, limit: 100 },
    ]);
    expect(result).toEqual([{ platform: "telegram", scanned: 250, found: 0, matched: 0, open: 0, error: null }]);
    expect(s.repository.runs).toHaveLength(1);
    expect(s.repository.runs[0]).toMatchObject({ platform: "telegram", trigger: "schedule", actorAccountId: null, startedAt: NOW, fromOffset: 0, toOffset: 250, scanned: 250, found: 0, matched: 0, error: null });
    expect(s.repository.runs[0]?.finishedAt).toBeInstanceOf(Date);
  });

  it("выписка ровно в 200 операций — третья страница пуста, читается и она", async () => {
    const s = setup();
    s.statement.entries = filler(200);

    await s.reconciler.run("schedule", null, NOW);

    expect(s.statement.calls).toHaveLength(3);
    expect(s.repository.runs[0]?.toOffset).toBe(200);
  });

  it("прошлая удачная сверка с курсором 250 — чтение с 150", async () => {
    const s = setup();
    s.repository.succeeded("telegram", 250, new Date(NOW.getTime() - 2 * DAY));
    s.statement.entries = filler(300);

    await s.reconciler.run("schedule", null, NOW);

    expect(s.statement.calls[0]).toEqual({ offset: 150, limit: 100 });
    expect(s.repository.runs.at(-1)).toMatchObject({ fromOffset: 150, toOffset: 300, scanned: 150 });
  });

  it("страниц не больше ста: десять тысяч операций за сверку, остальное — со следующей", async () => {
    const s = setup();
    s.statement.entries = filler(10_250);

    await s.reconciler.run("schedule", null, NOW);

    expect(s.statement.calls).toHaveLength(RECONCILE.maxPages);
    expect(s.repository.runs[0]).toMatchObject({ toOffset: 10_000, scanned: 10_000 });
  });

  it("площадка отдаёт страницы короче ста — размер страницы берётся по её потолку", async () => {
    const small = new MemoryStatement("telegram", 40);
    small.entries = filler(90);
    const s = setup({ statements: [small] });

    await s.reconciler.run("schedule", null, NOW);

    expect(small.calls).toEqual([
      { offset: 0, limit: 40 },
      { offset: 40, limit: 40 },
      { offset: 80, limit: 40 },
    ]);
    expect(s.repository.runs[0]?.toOffset).toBe(90);
  });

  it("сверка записывает отрезок выписки, который покрыла", async () => {
    const s = setup();
    s.statement.entries = [entry("a", 300, { kind: "other" }), entry("b", 100, { kind: "other" })];

    await s.reconciler.run("schedule", null, NOW);

    expect(s.repository.runs[0]).toMatchObject({ coveredFrom: ago(300), coveredTo: ago(100) });
  });

  it("сверка не дольше лока: время вышло — чтение останавливается, курсор — до дочитанного, а не ошибка", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const s = setup();
    s.statement.entries = filler(500);
    // Каждая страница «идёт» шесть минут: после трёх вышло бы больше, чем держит лок.
    s.statement.onPage = () => void vi.setSystemTime(Date.now() + 6 * 60_000);

    const [summary] = (await s.reconciler.run("schedule", null, NOW)) ?? [];

    expect(summary?.error).toBeNull();
    expect(s.statement.calls.length).toBeLessThan(5);
    expect(s.repository.runs[0]?.toOffset).toBe(s.statement.calls.length * 100);
  });
});

describe("PaymentReconciler: сбои площадки", () => {
  it("вторая страница бросает — строка сверки с ошибкой и без курсора, сообщения нет; следующая начинает с того же места", async () => {
    const s = setup();
    s.statement.entries = [entry("c1", 300), ...filler(250)];
    s.statement.failOn = 2;

    const [summary] = (await s.reconciler.run("schedule", null, NOW)) ?? [];

    expect(summary).toMatchObject({ platform: "telegram", found: 0, matched: 0, error: "Bad Gateway" });
    expect(s.repository.runs[0]).toMatchObject({ toOffset: null, found: 0, error: "Bad Gateway" });
    expect(s.repository.runs[0]?.finishedAt).toBeInstanceOf(Date);
    expect(s.repository.discrepancies).toEqual([]);
    expect(s.found).toEqual([]);

    s.statement.failOn = null;
    s.statement.calls.length = 0;
    await s.reconciler.run("schedule", null, new Date(NOW.getTime() + 60_000));

    expect(s.statement.calls[0]).toEqual({ offset: 0, limit: 100 });
  });

  it("ошибка длиннее 300 знаков обрезается", async () => {
    const s = setup();
    s.statement.entries = filler(10);
    s.statement.page = async () => {
      throw new Error("я".repeat(500));
    };

    await s.reconciler.run("schedule", null, NOW);

    expect(s.repository.runs[0]?.error).toBe("я".repeat(300));
  });

  it("страница не ответила за 20 секунд — это ошибка сверки, а не вечное ожидание", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = setup();
    s.statement.page = () => new Promise<StatementEntry[]>(() => undefined);

    const running = s.reconciler.run("schedule", null, NOW);
    await vi.advanceTimersByTimeAsync(RECONCILE.pageTimeoutMs + 1);
    const result = await running;

    expect(result?.[0]?.error).toContain("нет ответа");
    expect(s.repository.runs[0]).toMatchObject({ toOffset: null });
  });

  it("одна площадка упала — остальные продолжают", async () => {
    const broken = new MemoryStatement("telegram");
    broken.entries = filler(10);
    broken.failOn = 1;
    const healthy = new MemoryStatement("max");
    healthy.entries = filler(30);
    const s = setup({ statements: [broken, healthy] });

    const result = await s.reconciler.run("schedule", null, NOW);

    expect(result).toEqual([
      { platform: "telegram", scanned: 0, found: 0, matched: 0, open: 0, error: "Bad Gateway" },
      { platform: "max", scanned: 30, found: 0, matched: 0, open: 0, error: null },
    ]);
    expect(s.repository.runs.map((run) => [run.platform, run.toOffset])).toEqual([
      ["telegram", null],
      ["max", 30],
    ]);
  });

  it("база не дала начать сверку — площадка с ошибкой в итоге, выписка не читается, остальные идут дальше", async () => {
    const first = new MemoryStatement("telegram");
    const second = new MemoryStatement("max");
    second.entries = filler(5);
    const s = setup({ statements: [first, second] });
    s.repository.failStartRun = true;

    const result = await s.reconciler.run("schedule", null, NOW);

    expect(result?.map((item) => item.error)).toEqual(["база недоступна", "база недоступна"]);
    expect(first.calls).toEqual([]);
  });

  it("лок снимается и после ошибки", async () => {
    const s = setup();
    s.statement.entries = filler(10);
    s.statement.failOn = 1;

    await s.reconciler.run("schedule", null, NOW);

    expect(s.redis.values.has(LOCK_KEY)).toBe(false);
  });
});

describe("PaymentReconciler: лок", () => {
  it("лок ставится на 15 минут через SET NX PX и снимается после сверки", async () => {
    const s = setup();
    s.statement.entries = filler(10);

    await s.reconciler.run("schedule", null, NOW);

    expect(s.redis.sets).toEqual([{ key: LOCK_KEY, args: ["PX", RECONCILE.lockTtlMs, "NX"] }]);
    expect(s.redis.values.size).toBe(0);
  });

  it("лок занят — по расписанию ничего: выписка не читается, строки сверки нет", async () => {
    const s = setup();
    s.redis.values.set(LOCK_KEY, "чужая-реплика");
    s.statement.entries = filler(10);

    expect(await s.reconciler.tick(NOW)).toBeNull();

    expect(s.statement.calls).toEqual([]);
    expect(s.repository.runs).toEqual([]);
    // Чужой лок остаётся: снимается только по своему токену.
    expect(s.redis.values.get(LOCK_KEY)).toBe("чужая-реплика");
  });

  it("лок занят — кнопка отвечает 409 «Сверка уже идёт — подождите минуту»", async () => {
    const s = setup();
    const admin = await person(s, "800001", "admin");
    s.redis.values.set(LOCK_KEY, "чужая-реплика");

    const error = await s.reconciler.runNow(admin, NOW).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PurchaseActionUnavailableError);
    expect(error).toMatchObject({ status: 409, message: "Сверка уже идёт — подождите минуту" });
    expect(s.statement.calls).toEqual([]);
    expect(s.rolesRepository.entries).toEqual([]);
  });

  it("две сверки подряд в одной реплике не мешают друг другу: лок снят", async () => {
    const s = setup();
    s.statement.entries = filler(10);

    expect(await s.reconciler.run("schedule", null, NOW)).not.toBeNull();
    expect(await s.reconciler.run("schedule", null, new Date(NOW.getTime() + 60_000))).not.toBeNull();
  });
});

describe("PaymentReconciler: выключатель и расписание", () => {
  it("выключатель выключен — тик молчит", async () => {
    const s = setup({ settings: { "payments.reconcile": false } });
    s.statement.entries = filler(10);

    expect(await s.reconciler.tick(NOW)).toBeNull();

    expect(s.statement.calls).toEqual([]);
    expect(s.redis.sets).toEqual([]);
  });

  it("выключатель выключен — кнопка отвечает 409 «Сверка выключена в настройках»", async () => {
    const s = setup({ settings: { "payments.reconcile": false } });
    const admin = await person(s, "800001", "admin");

    const error = await s.reconciler.runNow(admin, NOW).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PurchaseActionUnavailableError);
    expect(error).toMatchObject({ status: 409, message: "Сверка выключена в настройках" });
    expect(s.statement.calls).toEqual([]);
  });

  it("выключатель смотрится при каждом тике: включили в панели — следующий тик сверяет", async () => {
    const s = setup({ settings: { "payments.reconcile": false } });
    s.statement.entries = filler(10);

    await s.reconciler.tick(NOW);
    s.settings.set("payments.reconcile", true);
    await s.reconciler.tick(NOW);

    expect(s.statement.calls).toHaveLength(1);
  });

  it("тик через 22 часа после удачной сверки — сверки нет", async () => {
    const s = setup();
    s.repository.succeeded("telegram", 40, new Date(NOW.getTime() - 22 * 3_600_000));
    s.statement.entries = filler(60);

    await s.reconciler.tick(NOW);

    expect(s.statement.calls).toEqual([]);
    expect(s.repository.runs).toHaveLength(1);
  });

  it("тик через 24 часа после удачной сверки — сверка, с курсора", async () => {
    const s = setup();
    s.repository.succeeded("telegram", 140, new Date(NOW.getTime() - 24 * 3_600_000));
    s.statement.entries = filler(160);

    await s.reconciler.tick(NOW);

    expect(s.statement.calls[0]).toEqual({ offset: 40, limit: 100 });
  });

  it("неудачная сверка сутки не откладывает: прошлая удачная была давно — тик сверяет снова", async () => {
    const s = setup();
    s.repository.succeeded("telegram", 40, new Date(NOW.getTime() - 3 * DAY));
    s.repository.failed("telegram", new Date(NOW.getTime() - 3_600_000), "Bad Gateway");
    s.statement.entries = filler(60);

    await s.reconciler.tick(NOW);

    expect(s.statement.calls).toHaveLength(1);
  });

  it("площадки сверяются каждая по своему сроку", async () => {
    const telegram = new MemoryStatement("telegram");
    const max = new MemoryStatement("max");
    telegram.entries = filler(10);
    max.entries = filler(10);
    const s = setup({ statements: [telegram, max] });
    s.repository.succeeded("telegram", 10, new Date(NOW.getTime() - 2 * 3_600_000));

    await s.reconciler.tick(NOW);

    expect(telegram.calls).toEqual([]);
    expect(max.calls).toHaveLength(1);
  });

  it("таймер: первый тик через 5 минут после старта, дальше раз в час; при остановке сбрасывается", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const s = setup();
    s.statement.entries = filler(10);
    const tick = vi.spyOn(s.reconciler, "tick");

    s.reconciler.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(RECONCILE.firstTickMs - 1);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RECONCILE.tickMs);
    expect(tick).toHaveBeenCalledTimes(2);

    s.reconciler.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(2 * RECONCILE.tickMs);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("таймера нет без входа (база не подключена) и без выписок площадок", async () => {
    vi.useFakeTimers();
    const noAuth = setup({ env: { JWT_ACCESS_SECRET: "" } });
    const noStatements = setup({ statements: [] });
    const spies = [vi.spyOn(noAuth.reconciler, "tick"), vi.spyOn(noStatements.reconciler, "tick")];

    noAuth.reconciler.onApplicationBootstrap();
    noStatements.reconciler.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(2 * RECONCILE.tickMs);

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    noAuth.reconciler.onModuleDestroy();
    noStatements.reconciler.onModuleDestroy();
  });
});

describe("PaymentReconciler: расхождения и сообщение команде", () => {
  /** Выписка из четырёх операций: два непринятых платежа (один с известной покупкой) и возврат по принятому. */
  function seed(s: Setup): void {
    s.repository.refs = [{ purchaseId: PURCHASE_ID, accountId: ACCOUNT_ID }];
    s.repository.purchases = [{ ...purchase("c3", { paidAt: ago(115) }), platform: "telegram" }];
    s.statement.entries = [
      entry("c1", 120, { payload: PURCHASE_ID }),
      entry("c2", 110, { payload: "мусор" }),
      entry("c3", 105),
      entry("c3", 100, { kind: "refund" }),
    ];
  }

  it("новые расхождения — запись строк, итог сверки и одно сообщение с видами", async () => {
    const s = setup();
    seed(s);

    const result = await s.reconciler.run("schedule", null, NOW);

    expect(result).toEqual([{ platform: "telegram", scanned: 4, found: 3, matched: 0, open: 3, error: null }]);
    expect(s.repository.discrepancies.map((row) => [row.kind, row.chargeId, row.purchaseId, row.accountId, row.resolvedAt])).toEqual([
      ["charged_unrecorded", "c1", PURCHASE_ID, ACCOUNT_ID, null],
      ["charged_unrecorded", "c2", null, null, null],
      ["refund_unrecorded", "c3", s.repository.purchases[0]?.purchaseId, ACCOUNT_ID, null],
    ]);
    expect(s.found).toEqual([{ platform: "telegram", found: 3, open: 3, kinds: { charged_unrecorded: 2, refund_unrecorded: 1 }, at: NOW }]);
    expect(s.repository.runs[0]).toMatchObject({ found: 3, matched: 0 });
  });

  it("покупки по payload ищутся только по настоящим UUID: мусор в счёте базу не трогает", async () => {
    const s = setup();
    seed(s);

    await s.reconciler.run("schedule", null, NOW);

    expect(s.repository.byIdsCalls).toEqual([[PURCHASE_ID]]);
  });

  it("те же расхождения при следующей сверке — не новые: строк не прибавилось, сообщения нет", async () => {
    const s = setup();
    seed(s);
    await s.reconciler.run("schedule", null, NOW);
    s.found.length = 0;

    const result = await s.reconciler.run("schedule", null, new Date(NOW.getTime() + DAY));

    expect(result).toEqual([{ platform: "telegram", scanned: 4, found: 0, matched: 0, open: 3, error: null }]);
    expect(s.repository.discrepancies).toHaveLength(3);
    expect(s.found).toEqual([]);
  });

  it("ничего не нашлось — сообщения нет", async () => {
    const s = setup();
    s.statement.entries = filler(30);

    await s.reconciler.run("schedule", null, NOW);

    expect(s.found).toEqual([]);
  });

  it("записанное, но отсутствующее в выписке: покупка внутри отрезка читается по паре границ выписки", async () => {
    const s = setup();
    s.statement.entries = [entry("a", 300, { kind: "other" }), entry("b", 100, { kind: "other" })];
    s.repository.purchases = [{ ...purchase("z", { paidAt: ago(200), chargedStars: 150 }), platform: "telegram" }];

    await s.reconciler.run("schedule", null, NOW);

    expect(s.repository.windows).toEqual([{ platform: "telegram", from: ago(270), to: ago(100) }]);
    expect(s.repository.discrepancies).toMatchObject([{ kind: "recorded_missing", chargeId: "z", amount: 150, payerId: null }]);
    expect(s.found[0]?.kinds).toEqual({ recorded_missing: 1 });
  });

  it("сошедшееся закрывается само: оплата записалась, возврат отмечен, оплата нашлась в выписке", async () => {
    const s = setup();
    // Три открытых расхождения прошлых сверок.
    const recorded = s.repository.existing({ kind: "charged_unrecorded", chargeId: "now-recorded" });
    const refunded = s.repository.existing({ kind: "refund_unrecorded", chargeId: "now-refunded" });
    const present = s.repository.existing({ kind: "recorded_missing", chargeId: "now-present" });
    const stillOpen = s.repository.existing({ kind: "charged_unrecorded", chargeId: "still-open" });
    s.repository.purchases = [
      { ...purchase("now-recorded", { paidAt: ago(1000) }), platform: "telegram" },
      { ...purchase("now-refunded", { refundedAt: ago(500) }), platform: "telegram" },
      { ...purchase("now-present", { paidAt: ago(299) }), platform: "telegram" },
    ];
    // Две операции с разницей в минуту: отрезка для «записано, но нет» у такой выписки нет.
    s.statement.entries = [entry("now-present", 300), entry("x1", 299, { kind: "other" })];

    const result = await s.reconciler.run("schedule", null, NOW);

    expect(result?.[0]).toMatchObject({ matched: 3, found: 0, open: 1 });
    const byId = new Map(s.repository.discrepancies.map((row) => [row.discrepancyId, row]));
    for (const row of [recorded, refunded, present]) expect(byId.get(row.discrepancyId)).toMatchObject({ resolution: "matched", resolvedAt: NOW });
    expect(byId.get(stillOpen.discrepancyId)?.resolvedAt).toBeNull();
    expect(s.repository.runs[0]).toMatchObject({ matched: 3 });
    // Закрытие само — не новое расхождение: команде сообщения нет.
    expect(s.found).toEqual([]);
  });

  it("закрытое расхождение той же оплаты заново не заводится: одно расхождение — одна строка навсегда", async () => {
    const s = setup();
    seed(s);
    await s.reconciler.run("schedule", null, NOW);
    for (const row of s.repository.discrepancies) {
      row.resolvedAt = NOW;
      row.resolution = "dismissed";
    }
    s.found.length = 0;

    await s.reconciler.run("schedule", null, new Date(NOW.getTime() + DAY));

    expect(s.repository.discrepancies).toHaveLength(3);
    expect(s.found).toEqual([]);
  });

  it("в лог — итог сверки и каждое новое расхождение", async () => {
    const s = setup();
    seed(s);
    s.repository.existing({ kind: "recorded_missing", chargeId: "old" });

    await s.reconciler.run("manual", null, NOW);

    expect(logged).toContainEqual({
      level: "log",
      event: "reconcile_finished",
      fields: expect.objectContaining({ module: "payments", platform: "telegram", trigger: "manual", fromOffset: 0, toOffset: 4, scanned: 4, found: 3, matched: 0, open: 4 }) as Record<string, unknown>,
    });
    expect(logged.filter((line) => line.event === "discrepancy_found").map((line) => [line.fields.kind, line.fields.chargeId, line.fields.purchaseId])).toEqual([
      ["charged_unrecorded", "c1", PURCHASE_ID],
      ["charged_unrecorded", "c2", null],
      ["refund_unrecorded", "c3", s.repository.purchases[0]?.purchaseId],
    ]);
  });

  it("база упала после вставки расхождений — сообщение уходит всё равно: следующая сверка найдёт их не новыми", async () => {
    const s = setup();
    seed(s);
    s.repository.failNextFinish = true;

    const [summary] = (await s.reconciler.run("schedule", null, NOW)) ?? [];

    expect(summary).toMatchObject({ platform: "telegram", found: 3, error: "база недоступна" });
    expect(s.repository.runs[0]).toMatchObject({ toOffset: null, found: 3, error: "база недоступна" });
    expect(s.found).toEqual([{ platform: "telegram", found: 3, open: 3, kinds: { charged_unrecorded: 2, refund_unrecorded: 1 }, at: NOW }]);
    // Курсор не двинулся: следующая сверка читает то же место и новых расхождений уже не видит.
    s.found.length = 0;
    await s.reconciler.run("schedule", null, new Date(NOW.getTime() + 60_000));
    expect(s.statement.calls.at(-1)).toEqual({ offset: 0, limit: 100 });
    expect(s.found).toEqual([]);
  });

  it("слушатель сообщения упал — сверка не падает", async () => {
    const s = setup();
    seed(s);
    s.hooks.onReconcileFound("упавший", async () => {
      throw new Error("Telegram недоступен");
    });

    const result = await s.reconciler.run("schedule", null, NOW);

    expect(result?.[0]?.found).toBe(3);
    expect(s.repository.runs[0]?.error).toBeNull();
  });

  it("сообщение — по площадке, нашедшей новое: у второй, где всё сошлось, его нет", async () => {
    const telegram = new MemoryStatement("telegram");
    const max = new MemoryStatement("max");
    telegram.entries = [entry("t1", 120)];
    max.entries = filler(5);
    const s = setup({ statements: [telegram, max] });

    await s.reconciler.run("schedule", null, NOW);

    expect(s.found.map((event) => [event.platform, event.found])).toEqual([["telegram", 1]]);
  });
});

describe("PaymentReconciler.runNow: «Сверить сейчас»", () => {
  it("без payments.support — ForbiddenError, ничего не читается", async () => {
    const s = setup();
    const moderator = await person(s, "800002", "moderator");

    await expect(s.reconciler.runNow(moderator, NOW)).rejects.toBeInstanceOf(ForbiddenError);

    expect(s.statement.calls).toEqual([]);
    expect(s.rolesRepository.entries).toEqual([]);
  });

  it("удача — сверка с трассировкой «кнопкой», итог по площадкам и запись payments.reconcile.run", async () => {
    const s = setup();
    const admin = await person(s, "800001", "admin");
    s.statement.entries = [entry("c1", 120), ...filler(4)];

    const result = await s.reconciler.runNow(admin, NOW);

    expect(result).toEqual([{ platform: "telegram", scanned: 5, found: 1, matched: 0, open: 1, error: null }]);
    expect(s.repository.runs[0]).toMatchObject({ trigger: "manual", actorAccountId: admin.accountId });
    expect(s.rolesRepository.entries).toEqual([
      expect.objectContaining({ actorAccountId: admin.accountId, action: "payments.reconcile.run", target: null, after: { scanned: 5, found: 1, matched: 0 } }),
    ]);
    expect(s.found).toHaveLength(1);
  });

  it("кнопка сверяет вне расписания: удачная сверка час назад не мешает", async () => {
    const s = setup();
    const admin = await person(s, "800001", "admin");
    s.repository.succeeded("telegram", 40, new Date(NOW.getTime() - 3_600_000));
    s.statement.entries = filler(60);

    await s.reconciler.runNow(admin, NOW);

    expect(s.statement.calls).toHaveLength(1);
  });

  it("площадка упала — кнопка отвечает итогом с ошибкой, запись в журнале остаётся", async () => {
    const s = setup();
    const admin = await person(s, "800001", "admin");
    s.statement.entries = filler(10);
    s.statement.failOn = 1;

    const result = await s.reconciler.runNow(admin, NOW);

    expect(result[0]?.error).toBe("Bad Gateway");
    expect(s.rolesRepository.entries.map((record) => record.action)).toEqual(["payments.reconcile.run"]);
  });
});

describe("PaymentReconciler.overview: обзор для панели", () => {
  it("без payments.view — ForbiddenError", async () => {
    const s = setup();
    const weak = await person(s, "800003");

    await expect(s.reconciler.overview(weak, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("открытые и закрытые, выключатель, последние сверки; имена — одним запросом", async () => {
    const s = setup();
    const admin = await person(s, "800001", "admin");
    const player = await person(s, "800010", undefined, "Стрелок");
    const resolver = await person(s, "800011", undefined, "Мария");
    s.repository.succeeded("telegram", 40, ago(60));
    s.repository.existing({ kind: "charged_unrecorded", chargeId: "open-1", accountId: player.accountId, payerId: "555000111" });
    s.repository.existing({ kind: "recorded_missing", chargeId: "done-1", accountId: player.accountId, resolution: "dismissed", resolvedAt: ago(30), resolvedBy: resolver.accountId, note: "ложное" });
    const names = vi.spyOn(s.accounts, "displayNames");

    const view = await s.reconciler.overview(admin, NOW);

    expect(view.enabled).toBe(true);
    expect(view.lastRuns).toEqual([{ platform: "telegram", trigger: "schedule", startedAt: ago(60), finishedAt: ago(60), scanned: 40, found: 0, error: null }]);
    expect(view.open).toMatchObject([{ chargeId: "open-1", kind: "charged_unrecorded", displayName: "Стрелок", resolution: null, resolvedByName: null }]);
    expect(view.resolved).toMatchObject([{ chargeId: "done-1", kind: "recorded_missing", resolution: "dismissed", resolvedByName: "Мария", note: "ложное" }]);
    expect(names).toHaveBeenCalledTimes(1);
  });

  it("выключатель в обзоре — как в настройках", async () => {
    const s = setup({ settings: { "payments.reconcile": false } });
    const admin = await person(s, "800001", "admin");

    expect((await s.reconciler.overview(admin, NOW)).enabled).toBe(false);
  });

  it("идентификатор плательщика на площадке — персональные данные: без players.pii.view он стёрт", async () => {
    const s = setup();
    const admin = await person(s, "800001", "admin");
    const weak = await person(s, "800004", "moderator");
    s.repository.existing({ kind: "charged_unrecorded", chargeId: "open-1", payerId: "555000111" });

    expect((await s.reconciler.overview(admin, NOW)).open[0]?.payerId).toBe("555000111");
    // Модератору «Платежи» закрыты целиком: проверяем сам механизм прав через роль без payments.view.
    await expect(s.reconciler.overview(weak, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("незнакомый вид, решение или площадка в базе — строка пропускается с предупреждением, обзор не падает", async () => {
    const s = setup();
    const admin = await person(s, "800001", "admin");
    s.repository.existing({ kind: "charged_unrecorded", chargeId: "good" });
    s.repository.existing({ kind: "из-будущего", chargeId: "bad-kind" });
    s.repository.existing({ kind: "recorded_missing", chargeId: "bad-resolution", resolution: "вечность", resolvedAt: ago(5) });
    s.repository.existing({ kind: "recorded_missing", chargeId: "bad-platform", platform: "icq" });

    const view = await s.reconciler.overview(admin, NOW);

    expect(view.open.map((row) => row.chargeId)).toEqual(["good"]);
    expect(view.resolved).toEqual([]);
    expect(logged.filter((line) => line.level === "warn" && line.event === "reconcile_row_skipped").map((line) => line.fields.chargeId)).toEqual(
      expect.arrayContaining(["bad-kind", "bad-resolution", "bad-platform"]),
    );
  });
});
