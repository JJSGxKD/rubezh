import { findEntryProblems, type EntryLine, type LedgerAccount } from "@bh/ledger";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/app-config.js";
import { LedgerSyncJob, LedgerSyncPass, SYNC_INTERVAL_MS } from "../src/modules/ledger/ledger-sync.job.js";
import type { LedgerPostInput, PostResult } from "../src/modules/ledger/ledger.service.js";
import {
  paymentSourceKey,
  planPostings,
  type PlannedPosting,
  type PostablePurchase,
  type PostedState,
  type PostingPlanInput,
} from "../src/modules/ledger/payment-postings.js";
import { cursorOf, type PaymentPostingsRepository, type PostingCandidate, type PostingStream, type StreamCursor } from "../src/modules/ledger/payment-postings.repository.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { panelSettings } from "./helpers/settings.js";

/** Очередь и воркер BullMQ подменены: тест расписания не ходит в Redis, а только считает, что завели. */
const bull = vi.hoisted(() => ({ queues: 0, workers: 0, schedulers: [] as unknown[][] }));
vi.mock("bullmq", () => ({
  Queue: class {
    constructor() {
      bull.queues += 1;
    }
    upsertJobScheduler(...args: unknown[]): Promise<void> {
      bull.schedulers.push(args);
      return Promise.resolve();
    }
    add(): Promise<void> {
      return Promise.resolve();
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  },
  Worker: class {
    constructor() {
      bull.workers += 1;
    }
    on(): this {
      return this;
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

/**
 * Правила проводок из платежей (Р219, tasks/T-0458, docs/37-accounting.md §4, §5, §8): чистая функция без базы.
 * Что и в каком порядке нужно провести по покупке сейчас, зная, что уже проведено. Порядок холда и возврата
 * решают даты, а не то, когда сработало задание; срок холда живёт в проводке оплаты и от настройки не зависит.
 */

const DAY_MS = 86_400_000;
const PAID_AT = new Date("2026-11-01T12:00:00.000Z");
/** 1 ноября + 21 день */
const RELEASE_AT = new Date("2026-11-22T12:00:00.000Z");

/** План счетов на старте (docs/37-accounting.md §3) — только то, чем пользуются проводки из платежей. */
const ACCOUNTS: ReadonlyMap<string, LedgerAccount> = new Map(
  [
    { id: "stars.bot.hold", type: "asset" as const, currency: "XTR", name: "Звёзды бота — в холде" },
    { id: "stars.bot.available", type: "asset" as const, currency: "XTR", name: "Звёзды бота — доступно" },
    { id: "revenue.shop.telegram", type: "revenue" as const, currency: "XTR", name: "Выручка: магазин, Telegram" },
    { id: "revenue.continue.telegram", type: "revenue" as const, currency: "XTR", name: "Выручка: второй шанс, Telegram" },
    { id: "revenue.vip.telegram", type: "revenue" as const, currency: "XTR", name: "Выручка: VIP, Telegram" },
    { id: "revenue.donation.telegram", type: "revenue" as const, currency: "XTR", name: "Донаты, Telegram" },
  ].map((account) => [account.id, account]),
);

function purchase(patch: Partial<PostablePurchase> = {}): PostablePurchase {
  return {
    purchaseId: "p-1",
    product: "shop_item",
    chargedStars: 50,
    mode: "live",
    paidAt: PAID_AT,
    refundedAt: null,
    platform: "telegram",
    ...patch,
  };
}

const NOTHING: PostedState = { paid: null, release: false, refund: false };
const PAID: PostedState = { paid: { releaseAt: RELEASE_AT }, release: false, refund: false };
const PAID_AND_RELEASED: PostedState = { paid: { releaseAt: RELEASE_AT }, release: true, refund: false };

function plan(patch: Partial<PostingPlanInput> = {}) {
  return planPostings({ purchase: purchase(), holdDays: 21, now: new Date("2026-11-13T00:10:00.000Z"), posted: NOTHING, ...patch });
}

const days = (n: number) => new Date(PAID_AT.getTime() + n * DAY_MS);

/** Итог проводок по счетам: сколько каждый из них изменится, если провести всё. */
function totals(postings: readonly PlannedPosting[]): Record<string, bigint> {
  const sums: Record<string, bigint> = {};
  for (const posting of postings) {
    for (const line of posting.entry.lines) sums[line.accountId] = (sums[line.accountId] ?? 0n) + line.amount;
  }
  return Object.fromEntries(Object.entries(sums).filter(([, amount]) => amount !== 0n));
}

const linesOf = (posting: PlannedPosting | undefined): EntryLine[] => posting?.entry.lines ?? [];

describe("проводки из платежей: оплата", () => {
  it("оплата без проводок — только «оплата»: холд плюс, выручка минус, срок выхода по holdDays", () => {
    const result = plan();

    expect(result.warning).toBeNull();
    expect(result.postings.map((posting) => posting.kind)).toEqual(["paid"]);
    const paid = result.postings[0]?.entry;
    expect(paid?.sourceKey).toBe("purchase:p-1:paid");
    expect(paid?.at).toEqual(PAID_AT);
    expect(paid?.lines).toEqual([
      { accountId: "stars.bot.hold", amount: 50n },
      { accountId: "revenue.shop.telegram", amount: -50n },
    ]);
    expect(paid?.meta).toEqual({ purchaseId: "p-1", product: "shop_item", releaseAt: RELEASE_AT.toISOString() });
    expect(paid?.reversalOf).toBeUndefined();
  });

  it("ключи источника — purchase:<id>:paid, :release и :refund", () => {
    expect(paymentSourceKey("abc", "paid")).toBe("purchase:abc:paid");
    expect(paymentSourceKey("abc", "release")).toBe("purchase:abc:release");
    expect(paymentSourceKey("abc", "refund")).toBe("purchase:abc:refund");
  });

  it("статья выручки — по виду покупки: магазин, второй шанс, VIP и донат", () => {
    const articles = (["shop_item", "continue_run", "vip", "donation"] as const).map((product) => {
      const paid = plan({ purchase: purchase({ product }) }).postings[0]?.entry;
      return paid?.lines.find((line) => line.amount < 0n)?.accountId;
    });

    expect(articles).toEqual(["revenue.shop.telegram", "revenue.continue.telegram", "revenue.vip.telegram", "revenue.donation.telegram"]);
  });

  it("оплата уже проведена и срок не вышел — ничего", () => {
    const result = plan({ posted: PAID, now: new Date("2026-11-21T23:59:59.000Z") });

    expect(result.postings).toEqual([]);
  });

  it("всё проведено — ничего, сколько бы ни прошло времени", () => {
    const result = plan({ purchase: purchase({ refundedAt: days(30) }), posted: { paid: { releaseAt: RELEASE_AT }, release: true, refund: true }, now: days(400) });

    expect(result.postings).toEqual([]);
  });

  it("донат — своя статья revenue.donation.telegram", () => {
    const result = plan({ purchase: purchase({ product: "donation", chargedStars: 100 }) });

    expect(result.postings[0]?.entry.lines).toEqual([
      { accountId: "stars.bot.hold", amount: 100n },
      { accountId: "revenue.donation.telegram", amount: -100n },
    ]);
    expect(result.postings[0]?.entry.meta).toMatchObject({ product: "donation" });
  });

  it("холд ноль дней: оплата и выход проводятся вместе, в этом порядке", () => {
    const result = plan({ holdDays: 0 });

    expect(result.postings.map((posting) => posting.kind)).toEqual(["paid", "release"]);
    expect(result.postings.map((posting) => posting.entry.at)).toEqual([PAID_AT, PAID_AT]);
  });
});

describe("проводки из платежей: выход из холда", () => {
  it("срок прошёл, оплата проведена — «выход»: холд минус, доступно плюс, на дату срока", () => {
    const result = plan({ posted: PAID, now: new Date("2026-11-22T12:00:00.000Z") });

    expect(result.postings.map((posting) => posting.kind)).toEqual(["release"]);
    const release = result.postings[0]?.entry;
    expect(release?.sourceKey).toBe("purchase:p-1:release");
    expect(release?.at).toEqual(RELEASE_AT);
    expect(release?.lines).toEqual([
      { accountId: "stars.bot.hold", amount: -50n },
      { accountId: "stars.bot.available", amount: 50n },
    ]);
  });

  it("срок не прошёл — выхода нет, за секунду до срока тоже", () => {
    expect(plan({ posted: PAID, now: new Date(RELEASE_AT.getTime() - 1_000) }).postings).toEqual([]);
  });

  it("задание не работало: оплата и выход за прошлое проводятся одним ответом, оплата первой", () => {
    const result = plan({ now: new Date("2026-12-31T00:00:00.000Z") });

    expect(result.postings.map((posting) => posting.kind)).toEqual(["paid", "release"]);
    expect(result.postings.map((posting) => posting.entry.at)).toEqual([PAID_AT, RELEASE_AT]);
    expect(totals(result.postings)).toEqual({ "stars.bot.available": 50n, "revenue.shop.telegram": -50n });
  });

  it("срок из проведённой оплаты важнее нынешней настройки: смена holdDays старые оплаты не сдвигает", () => {
    // Оплату провели при 21 дне; теперь настройка 60 — выход всё равно по записанному сроку.
    const result = plan({ posted: PAID, holdDays: 60, now: new Date("2026-11-22T12:00:00.000Z") });
    expect(result.postings.map((posting) => posting.kind)).toEqual(["release"]);
    expect(result.postings[0]?.entry.at).toEqual(RELEASE_AT);

    // И наоборот: настройка 1 день, срок в проводке 22 ноября — до него выхода нет.
    expect(plan({ posted: PAID, holdDays: 1, now: new Date("2026-11-10T00:00:00.000Z") }).postings).toEqual([]);
  });

  it("у оплаты без проведённой проводки срок берётся по нынешней настройке", () => {
    const result = plan({ holdDays: 7, now: new Date("2026-12-31T00:00:00.000Z") });

    expect(result.postings[0]?.entry.meta).toMatchObject({ releaseAt: days(7).toISOString() });
    expect(result.postings[1]?.entry.at).toEqual(days(7));
  });

  it("выход уже проведён — второго нет", () => {
    expect(plan({ posted: PAID_AND_RELEASED, now: new Date("2026-12-31T00:00:00.000Z") }).postings).toEqual([]);
  });
});

describe("проводки из платежей: возврат", () => {
  it("возврат до срока — сторно оплаты со ссылкой на неё; выхода из холда нет", () => {
    const result = plan({ purchase: purchase({ refundedAt: new Date("2026-11-05T09:00:00.000Z") }), posted: PAID, now: new Date("2026-11-06T00:00:00.000Z") });

    expect(result.postings.map((posting) => posting.kind)).toEqual(["refund"]);
    const refund = result.postings[0]?.entry;
    expect(refund?.sourceKey).toBe("purchase:p-1:refund");
    expect(refund?.at).toEqual(new Date("2026-11-05T09:00:00.000Z"));
    expect(refund?.reversalOf).toBe("purchase:p-1:paid");
    expect(refund?.lines).toEqual([
      { accountId: "stars.bot.hold", amount: -50n },
      { accountId: "revenue.shop.telegram", amount: 50n },
    ]);
  });

  it("возврат до срока: выхода из холда нет ни сейчас, ни после срока, ни когда возврат проведён", () => {
    const refunded = purchase({ refundedAt: new Date("2026-11-05T09:00:00.000Z") });

    // Возврат ещё не проведён, срок давно прошёл: сначала возврат, выхода нет.
    expect(plan({ purchase: refunded, posted: PAID, now: new Date("2026-12-31T00:00:00.000Z") }).postings.map((posting) => posting.kind)).toEqual(["refund"]);
    // Возврат проведён, срок прошёл: ничего, и особенно — не «выход».
    expect(plan({ purchase: refunded, posted: { paid: { releaseAt: RELEASE_AT }, release: false, refund: true }, now: new Date("2026-12-31T00:00:00.000Z") }).postings).toEqual([]);
  });

  it("возврат до срока при непроведённой оплате: оплата, затем её сторно; на счетах остаются нули", () => {
    const result = plan({ purchase: purchase({ refundedAt: new Date("2026-11-05T09:00:00.000Z") }), now: new Date("2026-12-31T00:00:00.000Z") });

    expect(result.postings.map((posting) => posting.kind)).toEqual(["paid", "refund"]);
    expect(totals(result.postings)).toEqual({});
  });

  it("возврат после срока, выход не проведён — «выход», затем «возврат из доступного», в этом порядке", () => {
    const refundedAt = new Date("2026-11-25T10:00:00.000Z");
    const result = plan({ purchase: purchase({ refundedAt }), posted: PAID, now: new Date("2026-11-26T00:00:00.000Z") });

    expect(result.postings.map((posting) => posting.kind)).toEqual(["release", "refund"]);
    const refund = result.postings[1]?.entry;
    expect(refund?.at).toEqual(refundedAt);
    expect(refund?.reversalOf).toBeUndefined();
    expect(refund?.lines).toEqual([
      { accountId: "stars.bot.available", amount: -50n },
      { accountId: "revenue.shop.telegram", amount: 50n },
    ]);
    // Оплата проведена раньше: «выход» и «возврат» вместе снимают холд и возвращают выручку, «доступно» — ноль.
    expect(totals(result.postings)).toEqual({ "stars.bot.hold": -50n, "revenue.shop.telegram": 50n });
  });

  it("возврат после срока, выход проведён — только «возврат из доступного»", () => {
    const result = plan({ purchase: purchase({ refundedAt: new Date("2026-11-25T10:00:00.000Z") }), posted: PAID_AND_RELEASED, now: new Date("2026-11-26T00:00:00.000Z") });

    expect(result.postings.map((posting) => posting.kind)).toEqual(["refund"]);
    expect(linesOf(result.postings[0])).toEqual([
      { accountId: "stars.bot.available", amount: -50n },
      { accountId: "revenue.shop.telegram", amount: 50n },
    ]);
  });

  it("возврат ровно в момент срока — уже после выхода: сначала выход, потом возврат из доступного", () => {
    const result = plan({ purchase: purchase({ refundedAt: RELEASE_AT }), posted: PAID, now: new Date("2026-11-30T00:00:00.000Z") });

    expect(result.postings.map((posting) => posting.kind)).toEqual(["release", "refund"]);
    expect(result.postings[1]?.entry.reversalOf).toBeUndefined();
  });

  it("возврат за секунду до срока — сторно оплаты", () => {
    const result = plan({ purchase: purchase({ refundedAt: new Date(RELEASE_AT.getTime() - 1_000) }), posted: PAID, now: new Date("2026-11-30T00:00:00.000Z") });

    expect(result.postings.map((posting) => posting.kind)).toEqual(["refund"]);
    expect(result.postings[0]?.entry.reversalOf).toBe("purchase:p-1:paid");
  });

  it("возврат, о котором узнали задним числом: выход уже проведён — возврат из доступного, а не сторно оплаты", () => {
    // Дата возврата раньше срока (его внесли по выписке позже), но звёзды из холда уже вышли: сторно оплаты увело бы холд в минус.
    const result = plan({ purchase: purchase({ refundedAt: new Date("2026-11-05T09:00:00.000Z") }), posted: PAID_AND_RELEASED, now: new Date("2026-11-30T00:00:00.000Z") });

    expect(result.postings.map((posting) => posting.kind)).toEqual(["refund"]);
    expect(result.postings[0]?.entry.reversalOf).toBeUndefined();
    expect(linesOf(result.postings[0])).toEqual([
      { accountId: "stars.bot.available", amount: -50n },
      { accountId: "revenue.shop.telegram", amount: 50n },
    ]);
  });

  it("возврат с датой в будущем (часы разошлись) ждёт своего времени", () => {
    const result = plan({ purchase: purchase({ refundedAt: new Date("2026-11-14T00:00:00.000Z") }), posted: PAID, now: new Date("2026-11-13T00:10:00.000Z") });

    expect(result.postings).toEqual([]);
  });

  it("возврат проведён, оплата и выход — тоже: ничего", () => {
    const posted: PostedState = { paid: { releaseAt: RELEASE_AT }, release: true, refund: true };

    expect(plan({ purchase: purchase({ refundedAt: new Date("2026-11-25T10:00:00.000Z") }), posted, now: days(100) }).postings).toEqual([]);
  });
});

describe("проводки из платежей: что в учёт не идёт", () => {
  it("тестовая оплата — ничего", () => {
    const result = plan({ purchase: purchase({ mode: "test", chargedStars: 1 }), now: days(100) });

    expect(result.postings).toEqual([]);
    expect(result.warning).toBeNull();
  });

  it("неоплаченная покупка — ничего", () => {
    expect(plan({ purchase: purchase({ paidAt: null }) }).postings).toEqual([]);
  });

  it("не Telegram — ничего и признак предупреждения: статей другой площадки в плане счетов ещё нет", () => {
    for (const platform of ["max", "vk", "web"]) {
      const result = plan({ purchase: purchase({ platform }), now: days(100) });
      expect(result.postings).toEqual([]);
      expect(result.warning).toBe("unsupported_platform");
    }
  });

  it("ноль звёзд или меньше — ничего и признак предупреждения: нулевую строку журнал не примет", () => {
    for (const chargedStars of [0, -5]) {
      const result = plan({ purchase: purchase({ chargedStars }), now: days(100) });
      expect(result.postings).toEqual([]);
      expect(result.warning).toBe("bad_amount");
    }
  });
});

describe("проводки из платежей: ядро учёта принимает каждую", () => {
  const cases: [string, Partial<PostingPlanInput>][] = [
    ["оплата", {}],
    ["оплата и выход", { now: days(40) }],
    ["оплата и возврат до срока", { purchase: purchase({ refundedAt: days(3) }), now: days(40) }],
    ["оплата, выход и возврат после срока", { purchase: purchase({ refundedAt: days(30) }), now: days(40) }],
    ["возврат после выхода", { purchase: purchase({ refundedAt: days(30) }), posted: PAID_AND_RELEASED, now: days(40) }],
    ["донат целиком", { purchase: purchase({ product: "donation", chargedStars: 5000 }), now: days(40) }],
    ["второй шанс и VIP", { purchase: purchase({ product: "vip", chargedStars: 1 }), now: days(40) }],
  ];

  for (const [name, patch] of cases) {
    it(`${name}: findEntryProblems без проблем, ключи разные, сумма строк по каждой проводке ноль`, () => {
      const result = plan(patch);

      expect(result.postings.length).toBeGreaterThan(0);
      for (const posting of result.postings) {
        expect(findEntryProblems(posting.entry, ACCOUNTS)).toEqual([]);
        expect(posting.entry.lines.reduce((sum, line) => sum + line.amount, 0n)).toBe(0n);
        expect(posting.entry.memo.length).toBeGreaterThan(0);
        expect(posting.entry.memo.length).toBeLessThanOrEqual(500);
      }
      const keys = result.postings.map((posting) => posting.entry.sourceKey);
      expect(new Set(keys).size).toBe(keys.length);
    });
  }

  it("у uuid-ключа хватает места: ключ источника не длиннее 128 знаков", () => {
    const result = plan({ purchase: purchase({ purchaseId: "0f8fad5b-d9cb-469f-a165-70867728950e", refundedAt: days(3) }), now: days(40) });

    expect(result.postings.map((posting) => findEntryProblems(posting.entry, ACCOUNTS))).toEqual([[], []]);
  });
});

describe("проводки из платежей: итог по счетам", () => {
  it("оплата без возврата: после выхода из холда на «доступно» ровно сумма оплаты", () => {
    const result = plan({ now: days(40) });

    expect(totals(result.postings)).toEqual({ "stars.bot.available": 50n, "revenue.shop.telegram": -50n });
  });

  it("возврат до срока: оплата и сторно гасят друг друга", () => {
    const result = plan({ purchase: purchase({ refundedAt: days(3) }), now: days(40) });

    expect(totals(result.postings)).toEqual({});
  });

  it("возврат после срока: к концу ни доступных звёзд, ни выручки", () => {
    const result = plan({ purchase: purchase({ refundedAt: days(30) }), now: days(40) });

    expect(totals(result.postings)).toEqual({});
  });
});

/**
 * Проход задания на подменённых репозитории и журнале (tasks/T-0458, шаг 3): сверка таблицы с журналом, порядок
 * проводок одной покупки, изоляция ошибок и догон прошлого. Правила шага 1 здесь не перепроверяются — только то,
 * что делает проход вокруг них. Запись в настоящую базу и гонку двух проходов — в интеграционном тесте.
 */

/** Журнал в памяти: ключ источника уникален, повтор — `created: false`, отказ можно назначить на ключ. */
class FakeLedger {
  readonly entries = new Map<string, LedgerPostInput>();
  readonly calls: string[] = [];
  readonly failing = new Set<string>();

  async post(input: LedgerPostInput): Promise<PostResult> {
    this.calls.push(input.sourceKey);
    if (this.failing.has(input.sourceKey)) throw new Error("база недоступна");
    if (this.entries.has(input.sourceKey)) return { entryId: input.sourceKey, created: false };
    this.entries.set(input.sourceKey, input);
    return { entryId: input.sourceKey, created: true };
  }
}

/** Три выборки репозитория по тем же правилам, что у SQL: что проведено, видно по журналу. */
class FakePostingsRepository implements PaymentPostingsRepository {
  purchases: PostablePurchase[] = [];

  constructor(private readonly ledger: FakeLedger) {}

  async candidates(stream: PostingStream, now: Date, after: StreamCursor | null, limit: number): Promise<PostingCandidate[]> {
    const rows = this.purchases
      .filter((p) => p.mode === "live" && p.paidAt !== null)
      .map((p): PostingCandidate => {
        const paid = this.ledger.entries.get(paymentSourceKey(p.purchaseId, "paid"));
        const releaseAt = paid?.meta?.releaseAt;
        return {
          purchase: p,
          posted: {
            paid: paid === undefined ? null : { releaseAt: typeof releaseAt === "string" ? new Date(releaseAt) : null },
            release: this.ledger.entries.has(paymentSourceKey(p.purchaseId, "release")),
            refund: this.ledger.entries.has(paymentSourceKey(p.purchaseId, "refund")),
          },
        };
      })
      .filter(({ purchase: p, posted }) => {
        if (stream === "unpaid") return posted.paid === null;
        if (stream === "unrefunded") return p.refundedAt !== null && p.refundedAt <= now && !posted.refund;
        const releaseAt = posted.paid?.releaseAt ?? null;
        return releaseAt !== null && !posted.release && releaseAt <= now && (p.refundedAt === null || p.refundedAt >= releaseAt);
      })
      .sort((a, b) => {
        const left = cursorOf(stream, a);
        const right = cursorOf(stream, b);
        return left.at.getTime() - right.at.getTime() || (left.purchaseId < right.purchaseId ? -1 : 1);
      })
      .filter((candidate) => {
        if (after === null) return true;
        const key = cursorOf(stream, candidate);
        return key.at.getTime() > after.at.getTime() || (key.at.getTime() === after.at.getTime() && key.purchaseId > after.purchaseId);
      });
    return rows.slice(0, limit);
  }
}

const NOW = new Date("2026-11-13T00:10:00.000Z");

function harness(settings = panelSettings()) {
  const ledger = new FakeLedger();
  const repository = new FakePostingsRepository(ledger);
  const pass = new LedgerSyncPass(repository, ledger, settings);
  pass.clock = () => NOW;
  return { ledger, repository, pass };
}

/** Покупка с номером: порядок оплат совпадает с номером, ключи читаются в отчёте теста. */
function bought(i: number, patch: Partial<PostablePurchase> = {}): PostablePurchase {
  return purchase({ purchaseId: `p-${String(i).padStart(3, "0")}`, paidAt: new Date(Date.UTC(2026, 9, 1, 0, i)), ...patch });
}

describe("задание сверки: проход", () => {
  it("проводит оплату, выход и возврат, считает итог по видам и исходам", async () => {
    const { ledger, repository, pass } = harness();
    repository.purchases = [
      bought(1), // оплата и выход
      bought(2, { refundedAt: new Date("2026-10-05T00:00:00.000Z") }), // оплата и сторно до срока
      bought(3, { refundedAt: new Date("2026-11-05T00:00:00.000Z") }), // оплата, выход, возврат из доступного
    ];

    const result = await pass.run();

    expect(result.drained).toBe(true);
    expect(result.postings.paid).toEqual({ created: 3, exists: 0, failed: 0 });
    expect(result.postings.release).toEqual({ created: 2, exists: 0, failed: 0 });
    expect(result.postings.refund).toEqual({ created: 2, exists: 0, failed: 0 });
    expect([...ledger.entries.keys()].sort()).toEqual(
      ["p-001:paid", "p-001:release", "p-002:paid", "p-002:refund", "p-003:paid", "p-003:refund", "p-003:release"].map((tail) => `purchase:${tail}`).sort(),
    );
  });

  it("порядок проводок одной покупки сохраняется: оплата, выход, возврат", async () => {
    const { ledger, repository, pass } = harness();
    repository.purchases = [bought(1, { refundedAt: new Date("2026-11-05T00:00:00.000Z") })];

    await pass.run();

    expect(ledger.calls).toEqual(["purchase:p-001:paid", "purchase:p-001:release", "purchase:p-001:refund"]);
  });

  it("второй проход ничего не создаёт и не обращается к журналу", async () => {
    const { ledger, repository, pass } = harness();
    repository.purchases = [bought(1), bought(2, { refundedAt: new Date("2026-11-05T00:00:00.000Z") })];
    await pass.run();
    const callsAfterFirst = ledger.calls.length;

    const second = await pass.run();

    expect(ledger.calls.length).toBe(callsAfterFirst);
    expect(second.postings.paid).toEqual({ created: 0, exists: 0, failed: 0 });
    expect(second.drained).toBe(true);
  });

  it("повтор того, что журнал уже знает, считается «уже есть», а не созданием", async () => {
    const { ledger, repository, pass } = harness();
    repository.purchases = [bought(1)];
    // Другой проход успел записать оплату между выборкой и записью — гонка двух реплик.
    const post = ledger.post.bind(ledger);
    ledger.post = async (input) => {
      if (input.sourceKey === "purchase:p-001:paid") await post(input);
      return await post(input);
    };

    const result = await pass.run();

    expect(result.postings.paid).toEqual({ created: 0, exists: 1, failed: 0 });
  });

  it("срок холда читается из настройки панели", async () => {
    const { ledger, repository, pass } = harness(panelSettings({ [SETTINGS.paymentsHoldDaysTelegram.key]: 7 }));
    const first = bought(1);
    repository.purchases = [first];

    await pass.run();

    const paid = ledger.entries.get("purchase:p-001:paid");
    expect(paid?.meta?.releaseAt).toBe(new Date((first.paidAt?.getTime() ?? 0) + 7 * DAY_MS).toISOString());
  });
});

describe("задание сверки: ошибки и догон", () => {
  it("ошибка одной покупки не останавливает проход; её следующие проводки пропущены, остальные проведены", async () => {
    const { ledger, repository, pass } = harness();
    repository.purchases = [bought(1), bought(2, { refundedAt: new Date("2026-11-05T00:00:00.000Z") }), bought(3)];
    ledger.failing.add("purchase:p-002:release");

    const result = await pass.run();

    expect(ledger.entries.has("purchase:p-001:release")).toBe(true);
    expect(ledger.entries.has("purchase:p-003:release")).toBe(true);
    // У второй провелась оплата, «выход» упал, «возврат» из доступного без него провести нельзя.
    expect(ledger.entries.has("purchase:p-002:paid")).toBe(true);
    expect(ledger.entries.has("purchase:p-002:refund")).toBe(false);
    expect(ledger.calls).not.toContain("purchase:p-002:refund");
    expect(result.postings.release.failed).toBe(1);
    expect(result.postings.refund.failed).toBe(0);
  });

  it("следующий проход доводит то, что упало", async () => {
    const { ledger, repository, pass } = harness();
    repository.purchases = [bought(1)];
    ledger.failing.add("purchase:p-001:paid");
    await pass.run();
    expect(ledger.entries.size).toBe(0);

    ledger.failing.clear();
    await pass.run();

    expect([...ledger.entries.keys()]).toEqual(["purchase:p-001:paid", "purchase:p-001:release"]);
  });

  it("выборка ровно в лимит — следующий круг сразу, а не через десять минут", async () => {
    const { ledger, repository, pass } = harness();
    pass.limit = 2;
    repository.purchases = [1, 2, 3, 4, 5].map((i) => bought(i));

    const result = await pass.run();

    expect(result.drained).toBe(true);
    expect(result.rounds).toBe(3);
    expect(result.postings.paid.created).toBe(5);
    expect(ledger.entries.has("purchase:p-005:paid")).toBe(true);
  });

  it("предел кругов на проход: проход возвращает «не всё», следующий продолжает с того же места", async () => {
    const { ledger, repository, pass } = harness();
    pass.limit = 2;
    pass.maxRounds = 1;
    repository.purchases = [1, 2, 3, 4, 5].map((i) => bought(i));

    const drained: boolean[] = [];
    for (let i = 0; i < 6; i += 1) {
      const result = await pass.run();
      drained.push(result.drained);
      if (result.drained) break;
    }

    expect(drained).toEqual([false, false, true]);
    expect([...ledger.entries.keys()].filter((key) => key.endsWith(":paid"))).toHaveLength(5);
  });

  it("бюджет времени на проход: исчерпан после первого круга — проход честно говорит «не всё»", async () => {
    const { repository, pass } = harness();
    pass.limit = 2;
    pass.budgetMs = 0;
    repository.purchases = [1, 2, 3, 4, 5].map((i) => bought(i));

    const result = await pass.run();

    expect(result.rounds).toBe(1);
    expect(result.drained).toBe(false);
  });

  it("покупки, которые не удаётся провести, не запирают очередь: хвост проводится, круг доходит до конца", async () => {
    const { ledger, repository, pass } = harness();
    pass.limit = 2;
    repository.purchases = [1, 2, 3, 4, 5].map((i) => bought(i));
    // Две самые ранние оплаты стабильно падают — как будто в базе неприводимые данные.
    ledger.failing.add("purchase:p-001:paid");
    ledger.failing.add("purchase:p-002:paid");

    const result = await pass.run();

    expect(result.drained).toBe(true);
    expect(["p-003", "p-004", "p-005"].every((id) => ledger.entries.has(`purchase:${id}:paid`))).toBe(true);
    expect(result.postings.paid.failed).toBe(2);
  });
});

describe("задание сверки: что в учёт не идёт", () => {
  it("другая площадка: ничего не проведено, проход идёт дальше, считается отдельно", async () => {
    const { ledger, repository, pass } = harness();
    repository.purchases = [bought(1, { platform: "vk" }), bought(2)];

    const result = await pass.run();

    expect(result.unsupported).toBe(1);
    expect(ledger.calls.some((key) => key.startsWith("purchase:p-001:"))).toBe(false);
    expect(ledger.entries.has("purchase:p-002:paid")).toBe(true);
    expect(result.drained).toBe(true);
  });

  it("тестовая оплата выборкой не берётся", async () => {
    const { ledger, repository, pass } = harness();
    repository.purchases = [bought(1, { mode: "test", chargedStars: 1 })];

    await pass.run();

    expect(ledger.calls).toEqual([]);
  });
});

describe("задание сверки: метрики", () => {
  it("счётчики ledger_postings_total по видам и исходам копятся между проходами, длительность — по проходу", async () => {
    const { ledger, repository, pass } = harness();
    repository.purchases = [bought(1), bought(2)];
    ledger.failing.add("purchase:p-002:paid");
    await pass.run();
    ledger.failing.clear();
    await pass.run();

    expect(pass.metrics.count("paid", "created")).toBe(2);
    expect(pass.metrics.count("paid", "failed")).toBe(1);
    expect(pass.metrics.count("release", "created")).toBe(2);
    expect(pass.metrics.count("refund", "created")).toBe(0);
    expect(pass.metrics.durations).toHaveLength(2);
    expect(pass.metrics.durations.every((seconds) => seconds >= 0)).toBe(true);
  });
});

describe("задание сверки: когда расписание запускается", () => {
  /** Конфигурация с адресами базы и Redis; настоящий клиент ioredis ленивый и до первой команды не соединяется. */
  const config = (patch: { databaseUrl?: string; possible?: boolean } = {}): AppConfig =>
    ({
      databaseUrl: patch.databaseUrl ?? "postgres://db.test/app",
      redisUrl: "redis://127.0.0.1:1",
      payments: { possible: patch.possible ?? true },
    }) as unknown as AppConfig;

  beforeEach(() => {
    bull.queues = 0;
    bull.workers = 0;
    bull.schedulers = [];
  });

  it("оплата возможна и база есть — заводятся очередь, воркер и расписание раз в десять минут", async () => {
    const job = new LedgerSyncJob(config(), harness().pass);

    await job.onApplicationBootstrap();

    expect(bull.queues).toBe(1);
    expect(bull.workers).toBe(1);
    expect(bull.schedulers).toHaveLength(1);
    expect(bull.schedulers[0]?.[0]).toBe("every-10-min");
    expect(bull.schedulers[0]?.[1]).toEqual({ every: SYNC_INTERVAL_MS });
    await job.onModuleDestroy();
  });

  it("оплата в процессе невозможна (нет входа или чтения обновлений бота) — задание не запускается", async () => {
    const job = new LedgerSyncJob(config({ possible: false }), harness().pass);

    await job.onApplicationBootstrap();
    await job.onModuleDestroy();

    expect(bull.queues).toBe(0);
    expect(bull.workers).toBe(0);
    expect(bull.schedulers).toEqual([]);
  });

  it("базы нет — задание не запускается", async () => {
    const job = new LedgerSyncJob(config({ databaseUrl: "" }), harness().pass);

    await job.onApplicationBootstrap();
    await job.onModuleDestroy();

    expect(bull.queues).toBe(0);
    expect(bull.workers).toBe(0);
  });
});
