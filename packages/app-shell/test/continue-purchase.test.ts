import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type InvoiceStatus, type KeyValueStorage, type PlatformAdapter, type RunResult } from "@bh/shared-types";
import type { RunEngine, RunEvents, RunOptions, RunSession } from "@bh/core-game";
import type { ApiResult } from "../src/state/api-request";
import type { ContinueInvoice, ContinueOffer, ContinueRequest, PaymentsApi, PurchaseState } from "../src/state/payments-api";

// Покупка второго шанса (docs/34-stage3-plan.md, WP5, шаг 3). Проверяется то,
// где оплата в клиенте обычно ломается: продолжение по ответу окна, а не по
// подтверждению сервера; ожидание без конца; повтор, берущий деньги дважды;
// и экран смерти, который ждёт решения, которого не принять.

const engine = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@bh/core-game", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bh/core-game")>()),
  loadRunEngine: engine.load,
}));

const { useRun } = await import("../src/state/run");
const { useMeta } = await import("../src/state/meta");
const { initShell } = await import("../src/state/shell");
const { CONFIRM_TIMEOUT_MS, setPaymentsApiForTests, useContinuePurchase } = await import("../src/state/continue-purchase");
const { canOfferPaidContinue, resetPaymentsAvailabilityForTests } = await import("../src/state/payments-availability");

const OFFER: ContinueOffer = { continueNo: 1, priceStars: 7, chargedStars: 7, mode: "live" };

function result(): RunResult {
  return {
    runId: "run-paid-1",
    seed: 42,
    outcome: "died",
    startingWeaponId: "spark",
    mapId: "frontier",
    difficultyId: "normal",
    contentHash: "abc",
    waveReached: 5,
    survivalSec: 385,
    level: 11,
    xpCollected: 600,
    enemiesKilled: 700,
    killsByEnemy: { swarm_rat: 700 },
    damageDealt: 9000,
    damageTaken: 300,
    weapons: [{ id: "spark", level: 5, damage: 9000 }],
    passives: [],
    deathCause: "swarm_rat",
    distance: 12_000,
    peakEnemies: 90,
    cheats: false,
    continues: [],
  };
}

type Handlers = { [E in keyof RunEvents]?: (payload: RunEvents[E]) => void };

function fakeEngine() {
  const handlers: Handlers = {};
  const calls: string[] = [];
  const started: RunOptions[] = [];
  const emit = <E extends keyof RunEvents>(event: E, payload: RunEvents[E]): void =>
    (handlers[event] as ((value: typeof payload) => void) | undefined)?.(payload);
  const session = {
    on<E extends keyof RunEvents>(event: E, handler: (payload: RunEvents[E]) => void) {
      (handlers as Record<string, unknown>)[event] = handler;
      return () => undefined;
    },
    continueRun: (options?: { cheat?: boolean }) => calls.push(options?.cheat === true ? "continue:cheat" : "continue"),
    declineContinue: () => {
      calls.push("decline");
      emit("finished", result());
    },
    restart: () => undefined,
    abandon: () => undefined,
    snapshot: () => null,
    destroy: () => undefined,
  } as unknown as RunSession;
  const fake: RunEngine = {
    start: (options) => {
      started.push(options);
      return session;
    },
  };
  return { engine: fake, emit, calls, started };
}

/** API оплаты в памяти: ответы задаёт тест, запросы он же и видит. */
class FakePayments implements PaymentsApi {
  quotes: ApiResult<ContinueOffer>[] = [];
  invoices: ApiResult<ContinueInvoice>[] = [];
  granted = false;
  readonly asked: string[] = [];

  async quote(request: ContinueRequest): Promise<ApiResult<ContinueOffer>> {
    this.asked.push(`quote:${request.continueNo}:${request.elapsedSec}`);
    return this.quotes.shift() ?? { ok: true, data: OFFER };
  }

  async invoice(): Promise<ApiResult<ContinueInvoice>> {
    this.asked.push("invoice");
    return this.invoices.shift() ?? { ok: true, data: { ...OFFER, purchaseId: "p-1", status: "pending", invoiceUrl: "https://t.me/$invoice" } };
  }

  async purchase(purchaseId: string): Promise<ApiResult<PurchaseState>> {
    this.asked.push(`purchase:${purchaseId}`);
    return { ok: true, data: { purchaseId, status: this.granted ? "paid" : "pending", granted: this.granted } };
  }
}

function memoryStorage(): KeyValueStorage {
  const values: Record<string, string> = {};
  return {
    get: (key) => values[key] ?? null,
    set: (key, value) => {
      values[key] = value;
    },
    remove: (key) => {
      delete values[key];
    },
  };
}

let payments: FakePayments;
let invoiceStatus: InvoiceStatus;
let opened: string[];
let events: { event: string; payload: Record<string, unknown> }[];

function mount(adapterPatch: Partial<PlatformAdapter> = {}): void {
  initShell({
    adapter: {
      ui: createNoopPlatformUi(),
      haptic: () => undefined,
      openInvoice: async (url: string) => {
        opened.push(url);
        return invoiceStatus;
      },
      ...adapterPatch,
    } as unknown as PlatformAdapter,
    capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false, auth: { baseUrl: "" } },
    storage: memoryStorage(),
    analytics: (event, payload) => void events.push({ event, payload: payload ?? {} }),
    build: { version: "test", contentHash: "abc", platform: "telegram" },
  });
  useMeta.getState().hydrate();
}

async function downed(): Promise<ReturnType<typeof fakeEngine>> {
  const fake = fakeEngine();
  engine.load.mockResolvedValue(fake.engine);
  await useRun.getState().start({ container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier", difficultyId: "normal" });
  fake.emit("downed", { result: result(), continuesLeft: 1 });
  return fake;
}

const named = (name: string) => events.filter((entry) => entry.event === name);

describe("покупка второго шанса", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    engine.load.mockReset();
    payments = new FakePayments();
    setPaymentsApiForTests(payments);
    resetPaymentsAvailabilityForTests();
    invoiceStatus = "paid";
    opened = [];
    events = [];
    mount();
    useContinuePurchase.getState().reset();
  });

  afterEach(() => {
    useContinuePurchase.getState().reset();
    useRun.getState().stop();
    vi.useRealTimers();
  });

  it("второй шанс предлагается игроку там, где его можно купить", async () => {
    const withPayments = await downed();
    expect(withPayments.started[0]?.continues).toBe(true);
    useRun.getState().stop();

    mount({ openInvoice: undefined });
    const without = await downed();
    expect(without.started[0]?.continues).toBe(false);
  });

  it("цену называет сервер — по секунде смерти и номеру продолжения", async () => {
    await downed();
    await useContinuePurchase.getState().prepare(result());

    expect(payments.asked).toEqual(["quote:1:385"]);
    expect(useContinuePurchase.getState().stage).toEqual({ kind: "ready", offer: OFFER });
  });

  it("продолжение — по подтверждению сервера, а не по ответу окна оплаты", async () => {
    const fake = await downed();
    await useContinuePurchase.getState().prepare(result());

    const buying = useContinuePurchase.getState().buy();
    await vi.advanceTimersByTimeAsync(0);
    // Окно сказало «оплачено», сервер ещё нет — движок не трогаем.
    expect(opened).toEqual(["https://t.me/$invoice"]);
    expect(useContinuePurchase.getState().stage.kind).toBe("confirming");
    expect(fake.calls).toEqual([]);

    payments.granted = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await buying;

    expect(fake.calls).toEqual(["continue"]);
    expect(named("purchase_initiated")[0]?.payload).toMatchObject({ product: "continue_run", priceStars: 7, chargedStars: 7, mode: "live" });
    expect(named("purchase_completed")).toHaveLength(1);
  });

  it("не дождались подтверждения — честно говорим, а повтор ждёт той же покупки, не выставляя новый счёт", async () => {
    const fake = await downed();
    await useContinuePurchase.getState().prepare(result());

    const buying = useContinuePurchase.getState().buy();
    await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS + 1_000);
    await buying;

    expect(useContinuePurchase.getState().stage).toMatchObject({ kind: "retry", reason: "slow_confirmation", purchaseId: "p-1" });
    expect(named("purchase_failed")[0]?.payload).toMatchObject({ reason: "timeout" });
    expect(fake.calls).toEqual([]);

    payments.granted = true;
    await useContinuePurchase.getState().retry();
    expect(fake.calls).toEqual(["continue"]);
    expect(payments.asked.filter((call) => call === "invoice")).toHaveLength(1);
  });

  it("закрыл окно оплаты — снова выбор, продолжения нет", async () => {
    const fake = await downed();
    invoiceStatus = "cancelled";
    await useContinuePurchase.getState().prepare(result());

    await useContinuePurchase.getState().buy();

    expect(useContinuePurchase.getState().stage).toEqual({ kind: "ready", offer: OFFER });
    expect(named("purchase_failed")[0]?.payload).toMatchObject({ reason: "cancelled" });
    expect(fake.calls).toEqual([]);
  });

  it("оплата уже прошла, а ответ потерялся — продолжение без второго окна и второй оплаты", async () => {
    const fake = await downed();
    payments.invoices = [{ ok: true, data: { ...OFFER, purchaseId: "p-1", status: "paid", invoiceUrl: null } }];
    payments.granted = true;
    await useContinuePurchase.getState().prepare(result());

    await useContinuePurchase.getState().buy();

    expect(opened).toEqual([]);
    expect(fake.calls).toEqual(["continue"]);
  });

  it("сервер не видел старта — спрашивает ещё раз, потом закрывает забег: ждать нечего", async () => {
    const fake = await downed();
    const unverified: ApiResult<ContinueOffer> = { ok: false, failure: "unavailable", code: "run_unverified" };
    payments.quotes = [unverified, unverified];

    const preparing = useContinuePurchase.getState().prepare(result());
    await vi.advanceTimersByTimeAsync(2_000);
    await preparing;

    expect(payments.asked).toEqual(["quote:1:385", "quote:1:385"]);
    expect(useContinuePurchase.getState().stage).toEqual({ kind: "unavailable", reason: "unverified" });
    expect(fake.calls).toEqual(["decline"]);
    expect(useRun.getState().phase).toBe("finished");
  });

  it("оплата выключена на сервере — дальше в этом запуске её не предлагают", async () => {
    await downed();
    payments.quotes = [{ ok: false, failure: "disabled" }];

    await useContinuePurchase.getState().prepare(result());

    expect(useContinuePurchase.getState().stage).toEqual({ kind: "unavailable", reason: "not_offered" });
    expect(canOfferPaidContinue()).toBe(false);
  });

  it("нет сети — повтор спрашивает цену снова, забег ждёт", async () => {
    const fake = await downed();
    payments.quotes = [{ ok: false, failure: "offline" }];
    await useContinuePurchase.getState().prepare(result());
    expect(useContinuePurchase.getState().stage).toMatchObject({ kind: "retry", reason: "offline", offer: null });
    expect(fake.calls).toEqual([]);

    await useContinuePurchase.getState().retry();

    expect(useContinuePurchase.getState().stage).toEqual({ kind: "ready", offer: OFFER });
  });

  it("ушёл с экрана смерти посреди ожидания — движку ничего не шлётся", async () => {
    const fake = await downed();
    await useContinuePurchase.getState().prepare(result());
    const buying = useContinuePurchase.getState().buy();
    await vi.advanceTimersByTimeAsync(0);

    useContinuePurchase.getState().reset();
    payments.granted = true;
    await vi.advanceTimersByTimeAsync(2_000);
    await buying;

    expect(fake.calls).toEqual([]);
  });
});
