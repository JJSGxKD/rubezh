import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION_METADATA } from "../src/common/access.js";
import { ForbiddenError, ValidationError } from "../src/common/domain-error.js";
import { AdminPaymentsController } from "../src/modules/admin/admin-payments.controller.js";
import { feedFiltersOf, paymentsFeedQuerySchema } from "../src/modules/admin/dto/admin-payments.dto.js";
import type { AccountRepository } from "../src/modules/auth/account.repository.js";
import { PaymentFeedSources, type PaymentFeedSource } from "../src/modules/payments/payment-feed-sources.js";
import { ACTION_ORDER, ACTION_PERMISSION, FEED_MARKS, mergeTimeline, purchaseTimeline, teamTimeline, TIMELINE_KINDS, type FeedMark, type TimelineEntry } from "../src/modules/payments/payment-timeline.js";
import { PurchaseNotFoundError } from "../src/modules/payments/payments-errors.js";
import { PaymentsFeed, type FeedFilters, type FeedPage } from "../src/modules/payments/payments-feed.service.js";
import type { FeedQuery, FeedRowRecord, PaymentsFeedRepository, PurchaseCardRecord } from "../src/modules/payments/payments-feed.repository.js";
import { PurchaseFulfillment } from "../src/modules/payments/purchase-fulfillment.js";
import type { PurchaseSupport } from "../src/modules/payments/purchase-support.js";
import type { PurchaseAction, StoredPurchase } from "../src/modules/payments/purchase-types.js";
import type { Permission } from "../src/modules/roles/permissions.js";
import type { AuditEntry, AuditQuery, AuditRecord } from "../src/modules/roles/roles.repository.js";
import type { AccountRef, RolesService } from "../src/modules/roles/roles.service.js";

/**
 * Лента платежей и карточка платежа в панели (tasks/T-0429, Р209, WP53):
 * правила хронологии без Nest и Prisma, реестр источников с потолком по
 * времени, сервис ленты и карточки на подставных репозитории, ролях и
 * источниках. Запрос к живой базе — `payments-feed.integration.test.ts`.
 */

const T0 = new Date("2026-11-11T10:00:00.000Z");
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const PURCHASE_ID = "11111111-1111-4111-8111-111111111111";

function purchase(patch: Partial<StoredPurchase> = {}): StoredPurchase {
  return {
    purchaseId: PURCHASE_ID,
    accountId: ACCOUNT_ID,
    product: "shop_item",
    runId: null,
    continueNo: null,
    elapsedSec: null,
    sku: "starter_pack",
    priceStars: 50,
    chargedStars: 50,
    mode: "live",
    status: "pending",
    telegramChargeId: null,
    invoicedAt: at(0),
    paidAt: null,
    refundReason: null,
    refundRequestedAt: null,
    refundedAt: null,
    fulfilledAt: null,
    renewalOf: null,
    ...patch,
  };
}

function paid(patch: Partial<StoredPurchase> = {}): StoredPurchase {
  return purchase({ status: "paid", telegramChargeId: `charge-${randomUUID()}`, paidAt: at(1), ...patch });
}

function entry(kind: TimelineEntry["kind"], minutes: number, text: string = kind): TimelineEntry {
  return { at: at(minutes), kind, text, actorName: null };
}

describe("перечни ленты", () => {
  it("виды строк хронологии идут в порядке жизни платежа, пометки ленты — три", () => {
    expect(TIMELINE_KINDS).toEqual(["invoice", "checkout", "paid", "renewal", "fulfilled", "refund_requested", "refunded", "compensated", "job_abandoned", "discrepancy", "team"]);
    expect(FEED_MARKS).toEqual(["compensated", "job_abandoned", "discrepancy"]);
  });

  it("право на действие: компенсация — своё, остальные — поддержка; порядок — сначала то, что не стоит денег", () => {
    expect(ACTION_PERMISSION).toEqual({ refund: "payments.support", fulfill: "payments.support", retry: "payments.support", compensate: "payments.compensate" });
    expect(ACTION_ORDER).toEqual(["fulfill", "retry", "refund", "compensate"]);
  });
});

describe("purchaseTimeline: хронология из самой покупки", () => {
  it("оплаченная, выданная и возвращённая вручную покупка — пять строк в порядке времени", () => {
    const row = paid({
      status: "refunded",
      fulfilledAt: at(2),
      refundReason: "manual",
      refundRequestedAt: at(30),
      refundedAt: at(31),
    });

    expect(purchaseTimeline(row, [])).toEqual([
      { at: at(0), kind: "invoice", text: "Счёт выставлен: 50 ⭐", actorName: null },
      { at: at(1), kind: "paid", text: "Оплата записана: списано 50 ⭐", actorName: null },
      { at: at(2), kind: "fulfilled", text: "Товар выдан", actorName: null },
      { at: at(30), kind: "refund_requested", text: "Возврат заказан: вручную, поддержка", actorName: null },
      { at: at(31), kind: "refunded", text: "Звёзды возвращены: вручную, поддержка", actorName: null },
    ]);
  });

  it("неоплаченная покупка — одна строка: счёт", () => {
    expect(purchaseTimeline(purchase(), [])).toEqual([{ at: at(0), kind: "invoice", text: "Счёт выставлен: 50 ⭐", actorName: null }]);
  });

  it("в тестовом режиме списана одна звезда, и счёт — на неё же", () => {
    const row = paid({ mode: "test", priceStars: 50, chargedStars: 1 });

    expect(purchaseTimeline(row, []).map((line) => line.text)).toEqual(["Счёт выставлен: 1 ⭐", "Оплата записана: списано 1 ⭐"]);
  });

  it("подписи причин возврата — как в панели", () => {
    const reasons = {
      test_mode: "тестовая оплата",
      unused: "второй шанс не использован",
      external: "вернули вне игры",
      undeliverable: "товара нет в каталоге",
      manual: "вручную, поддержка",
    } as const;

    for (const [reason, label] of Object.entries(reasons)) {
      const row = paid({ status: "refunded", refundReason: reason as keyof typeof reasons, refundRequestedAt: at(5), refundedAt: at(6) });
      const lines = purchaseTimeline(row, []);
      expect(lines.find((line) => line.kind === "refund_requested")?.text, reason).toBe(`Возврат заказан: ${label}`);
      expect(lines.find((line) => line.kind === "refunded")?.text, reason).toBe(`Звёзды возвращены: ${label}`);
    }
  });

  it("продления подписки — по строке на каждое, со временем их оплаты", () => {
    const first = paid({ product: "vip", sku: "vip", chargedStars: 150, fulfilledAt: at(2) });
    const renewals = [
      paid({ purchaseId: randomUUID(), product: "vip", sku: "vip", chargedStars: 150, renewalOf: first.purchaseId, invoicedAt: at(60), paidAt: at(60) }),
      paid({ purchaseId: randomUUID(), product: "vip", sku: "vip", chargedStars: 140, renewalOf: first.purchaseId, invoicedAt: at(120), paidAt: at(120) }),
    ];

    const lines = purchaseTimeline(first, renewals);

    expect(lines.filter((line) => line.kind === "renewal")).toEqual([
      { at: at(60), kind: "renewal", text: "Продление оплачено: 150 ⭐", actorName: null },
      { at: at(120), kind: "renewal", text: "Продление оплачено: 140 ⭐", actorName: null },
    ]);
    expect(lines.map((line) => line.at.getTime())).toEqual([...lines.map((line) => line.at.getTime())].sort((a, b) => a - b));
  });
});

describe("teamTimeline: действия команды из журнала", () => {
  function record(action: string, after: unknown, minutes: number, actorAccountId: string | null = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"): AuditRecord {
    return { entryId: randomUUID(), createdAt: at(minutes), actorAccountId, action, target: ACCOUNT_ID, after };
  }

  const names = new Map([["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Анна из поддержки"]]);

  it("запись payments.refund по этой покупке — строка с причиной и именем актёра из карты", () => {
    const lines = teamTimeline(PURCHASE_ID, [record("payments.refund", { purchaseId: PURCHASE_ID, reason: "manual", note: "Игрок написал в поддержку" }, 30)], names);

    expect(lines).toEqual([{ at: at(30), kind: "team", text: "Возврат звёзд вручную — Игрок написал в поддержку", actorName: "Анна из поддержки" }]);
  });

  it("запись по другой покупке и запись с битым after отбрасываются", () => {
    const lines = teamTimeline(
      PURCHASE_ID,
      [
        record("payments.refund", { purchaseId: randomUUID(), note: "чужая" }, 10),
        record("payments.fulfill", "не объект", 11),
        record("payments.fulfill", null, 12),
        record("payments.fulfill", { purchaseId: 42 }, 13),
        record("payments.fulfill", { note: "без покупки" }, 14),
        record("payments.fulfill", { purchaseId: PURCHASE_ID, note: "наша" }, 15),
      ],
      names,
    );

    expect(lines.map((line) => line.text)).toEqual(["Повторная выдача — наша"]);
  });

  it("действия: подписи по перечню, без note — без « — », незнакомое payments.* — его имя как есть", () => {
    const texts: [string, string][] = [
      ["payments.refund", "Возврат звёзд вручную"],
      ["payments.fulfill", "Повторная выдача"],
      ["payments.retry", "Повтор учёта"],
      ["payments.compensate", "Компенсация"],
      ["payments.discrepancy.retry", "Повтор учёта по сверке"],
      ["payments.discrepancy.refund", "Возврат звёзд по сверке"],
      ["payments.discrepancy.dismiss", "Расхождение разобрано"],
      ["payments.job.retry", "Повтор брошенного задания"],
      ["payments.something.new", "payments.something.new"],
    ];

    for (const [action, text] of texts) {
      expect(teamTimeline(PURCHASE_ID, [record(action, { purchaseId: PURCHASE_ID }, 1)], names)[0]?.text, action).toBe(text);
    }
    expect(teamTimeline(PURCHASE_ID, [record("payments.retry", { purchaseId: PURCHASE_ID, note: "из выписки" }, 1)], names)[0]?.text).toBe("Повтор учёта — из выписки");
  });

  it("note не строка — как будто его нет; лишние поля after не мешают", () => {
    const lines = teamTimeline(PURCHASE_ID, [record("payments.compensate", { purchaseId: PURCHASE_ID, note: 5, gems: 120, extra: { deep: true } }, 1)], names);

    expect(lines[0]?.text).toBe("Компенсация");
  });

  it("действие системы — без имени; актёра нет в карте — его id; строка не длиннее 200 знаков", () => {
    const system = teamTimeline(PURCHASE_ID, [record("payments.retry", { purchaseId: PURCHASE_ID }, 1, null)], names);
    const unknown = teamTimeline(PURCHASE_ID, [record("payments.retry", { purchaseId: PURCHASE_ID }, 1, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")], names);
    const long = teamTimeline(PURCHASE_ID, [record("payments.discrepancy.refund", { purchaseId: PURCHASE_ID, note: "я".repeat(200) }, 1)], names);

    expect(system[0]?.actorName).toBeNull();
    expect(unknown[0]?.actorName).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(long[0]?.text.length).toBeLessThanOrEqual(200);
  });
});

describe("mergeTimeline: всё вместе", () => {
  it("по времени; при равном времени — в порядке TIMELINE_KINDS", () => {
    const merged = mergeTimeline([[entry("team", 5), entry("refunded", 5)], [entry("paid", 5), entry("invoice", 1)], [entry("compensated", 5), entry("fulfilled", 5)]]);

    expect(merged.map((line) => line.kind)).toEqual(["invoice", "paid", "fulfilled", "refunded", "compensated", "team"]);
    expect(merged[0]?.at).toEqual(at(1));
  });

  it("пустые части — пусто; входные массивы не меняются", () => {
    const part = [entry("paid", 2), entry("invoice", 1)];

    expect(mergeTimeline([])).toEqual([]);
    expect(mergeTimeline([[], []])).toEqual([]);
    mergeTimeline([part]);
    expect(part.map((line) => line.kind)).toEqual(["paid", "invoice"]);
  });
});

describe("PaymentFeedSources: реестр источников", () => {
  let warned: string[] = [];

  beforeEach(() => {
    warned = [];
    vi.spyOn(Logger.prototype, "warn").mockImplementation((line: unknown) => {
      warned.push(String(line));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function source(patch: Partial<PaymentFeedSource> = {}): PaymentFeedSource {
    return { timeline: async () => [], marks: async () => new Map(), actions: async () => [], ...patch };
  }

  const failures = (): Record<string, unknown>[] => warned.map((line) => JSON.parse(line) as Record<string, unknown>);

  it("строки, пометки и действия всех источников собираются вместе", async () => {
    const sources = new PaymentFeedSources();
    sources.register("первый", source({ timeline: async () => [entry("compensated", 3)], marks: async () => new Map([["p1", ["compensated"]]]), actions: async () => ["retry"] }));
    sources.register("второй", source({ timeline: async () => [entry("discrepancy", 4)], marks: async () => new Map([["p1", ["discrepancy"]], ["p2", ["job_abandoned"]]]), actions: async () => ["compensate"] }));

    expect((await sources.timeline(purchase())).map((line) => line.kind).sort()).toEqual(["compensated", "discrepancy"]);
    expect(await sources.marks(["p1", "p2", "p3"])).toEqual(
      new Map<string, FeedMark[]>([
        ["p1", ["compensated", "discrepancy"]],
        ["p2", ["job_abandoned"]],
      ]),
    );
    expect((await sources.actions(purchase())).sort()).toEqual(["compensate", "retry"]);
  });

  it("пометки и действия без повторов", async () => {
    const sources = new PaymentFeedSources();
    sources.register("а", source({ marks: async () => new Map([["p1", ["discrepancy"]]]), actions: async () => ["retry", "compensate"] }));
    sources.register("б", source({ marks: async () => new Map([["p1", ["discrepancy", "compensated"]]]), actions: async () => ["retry"] }));

    expect((await sources.marks(["p1"])).get("p1")).toEqual(["discrepancy", "compensated"]);
    expect(await sources.actions(purchase())).toEqual(["retry", "compensate"]);
  });

  it("источник, который бросает, не ломает сбор: его строк нет, в лог — feed_source_failed", async () => {
    const sources = new PaymentFeedSources();
    sources.register("падает", source({ timeline: async () => Promise.reject(new Error("база недоступна")), marks: async () => Promise.reject(new Error("база недоступна")), actions: async () => Promise.reject(new Error("база недоступна")) }));
    sources.register("целый", source({ timeline: async () => [entry("compensated", 3)], marks: async () => new Map([["p1", ["compensated"]]]), actions: async () => ["compensate"] }));

    expect(await sources.timeline(purchase())).toEqual([entry("compensated", 3)]);
    expect(await sources.marks(["p1"])).toEqual(new Map([["p1", ["compensated"]]]));
    expect(await sources.actions(purchase())).toEqual(["compensate"]);
    expect(failures()).toHaveLength(3);
    expect(failures()[0]).toEqual({ module: "payments", event: "feed_source_failed", source: "падает", reason: "база недоступна" });
  });

  it("источник, который не отвечает 3 секунды, отпускается: пустой вклад и feed_source_failed", async () => {
    vi.useFakeTimers();
    const sources = new PaymentFeedSources();
    sources.register("завис", source({ timeline: () => new Promise<TimelineEntry[]>(() => undefined) }));
    sources.register("целый", source({ timeline: async () => [entry("discrepancy", 4)] }));

    const pending = sources.timeline(purchase());
    await vi.advanceTimersByTimeAsync(2_999);
    expect(failures()).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);

    expect(await pending).toEqual([entry("discrepancy", 4)]);
    expect(failures()).toHaveLength(1);
    expect(failures()[0]).toMatchObject({ module: "payments", event: "feed_source_failed", source: "завис" });
    expect(String(failures()[0]?.reason)).toContain("источник ленты завис");
  });

  it("повторная регистрация того же имени заменяет источник, а не добавляет второй", async () => {
    const sources = new PaymentFeedSources();
    sources.register("сверка", source({ timeline: async () => [entry("discrepancy", 4, "старый")] }));
    sources.register("сверка", source({ timeline: async () => [entry("discrepancy", 4, "новый")] }));

    expect((await sources.timeline(purchase())).map((line) => line.text)).toEqual(["новый"]);
  });

  it("без источников — пусто", async () => {
    const sources = new PaymentFeedSources();

    expect(await sources.timeline(purchase())).toEqual([]);
    expect(await sources.marks(["p1"])).toEqual(new Map());
    expect(await sources.actions(purchase())).toEqual([]);
  });
});

/** Репозиторий ленты в памяти: страница по тем же правилам, что у настоящего — на лишней строке держится признак «дальше». */
class FakeFeedRepository implements PaymentsFeedRepository {
  readonly queries: FeedQuery[] = [];
  readonly cards = new Map<string, PurchaseCardRecord>();
  rows: FeedRowRecord[] = [];
  reads = 0;

  async page(query: FeedQuery): Promise<FeedRowRecord[]> {
    this.reads += 1;
    this.queries.push(query);
    return this.rows.slice(0, query.limit + 1);
  }

  async byId(purchaseId: string): Promise<PurchaseCardRecord | null> {
    this.reads += 1;
    return this.cards.get(purchaseId) ?? null;
  }

  async renewals(firstId: string): Promise<StoredPurchase[]> {
    this.reads += 1;
    return [...this.cards.values()].map((card) => card.purchase).filter((row) => row.renewalOf === firstId);
  }

  put(row: StoredPurchase, platform: "telegram" | "vk" = "telegram"): StoredPurchase {
    this.cards.set(row.purchaseId, { purchase: row, account: { displayName: "Стрелок", platform, platformUserId: "555000111", username: "strelok" } });
    return row;
  }
}

/** Роли с заданным набором прав: решает не состав ролей, а то, что проверяет сервис. */
class FakeRoles {
  readonly audits: AuditEntry[] = [];
  readonly auditQueries: { actor: AccountRef; query: AuditQuery }[] = [];
  records: AuditRecord[] = [];

  constructor(readonly granted: Set<Permission>) {}

  async can(_actor: AccountRef, permission: Permission): Promise<boolean> {
    return this.granted.has(permission);
  }

  async require(actor: AccountRef, permission: Permission): Promise<void> {
    if (!(await this.can(actor, permission))) throw new ForbiddenError("Недостаточно прав");
  }

  async auditPage(actor: AccountRef, query: AuditQuery): Promise<AuditRecord[]> {
    await this.require(actor, "audit.view");
    this.auditQueries.push({ actor, query });
    return this.records;
  }

  async audit(entryToWrite: AuditEntry): Promise<void> {
    this.audits.push(entryToWrite);
  }
}

const ACTOR: AccountRef = { accountId: "99999999-9999-4999-8999-999999999999", platform: "telegram", platformUserId: "777000111" };
const ALL: Permission[] = ["payments.view", "payments.support", "payments.compensate", "players.pii.view", "audit.view"];

function setup(granted: readonly Permission[] = ALL) {
  const repository = new FakeFeedRepository();
  const sources = new PaymentFeedSources();
  const roles = new FakeRoles(new Set(granted));
  const supportActions: PurchaseAction[] = ["fulfill", "refund"];
  const support = { actionsFor: () => [...supportActions] } as unknown as PurchaseSupport;
  const fulfillment = new PurchaseFulfillment();
  fulfillment.register("shop_item", async () => undefined);
  fulfillment.register("vip", async () => undefined);
  const names = new Map([["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Анна из поддержки"]]);
  const accounts = { displayNames: async (ids: readonly string[]) => new Map([...names].filter(([id]) => ids.includes(id))) } as unknown as AccountRepository;
  const feed = new PaymentsFeed(repository, sources, support, fulfillment, roles as unknown as RolesService, accounts);
  return { repository, sources, roles, feed, fulfillment, supportActions };
}

function filters(patch: Partial<FeedFilters> = {}): FeedFilters {
  return { status: null, product: null, from: null, to: null, accountId: null, platform: null, mode: null, search: null, ...patch };
}

function feedRow(row: StoredPurchase): FeedRowRecord {
  return { purchase: row, account: { displayName: "Стрелок", platform: "telegram" } };
}

describe("PaymentsFeed.page: лента", () => {
  it("без payments.view — отказ, база не читается", async () => {
    const { feed, repository } = setup(["payments.support", "audit.view"]);

    await expect(feed.page(ACTOR, filters(), null, 50)).rejects.toBeInstanceOf(ForbiddenError);
    expect(repository.reads).toBe(0);
  });

  it("битый курсор — ValidationError с текстом про устаревшую ссылку, база не читается", async () => {
    const { feed, repository } = setup();
    const bad = [
      "!!!",
      Buffer.from("без-разделителя", "utf8").toString("base64url"),
      Buffer.from(`не-дата|${randomUUID()}`, "utf8").toString("base64url"),
      Buffer.from(`${at(1).toISOString()}|не-uuid`, "utf8").toString("base64url"),
      Buffer.from(`${at(1).toISOString()}|${randomUUID()}|лишнее`, "utf8").toString("base64url"),
    ];

    for (const cursor of bad) {
      const failure = await feed.page(ACTOR, filters(), cursor, 50).catch((error: unknown) => error);
      expect(failure, cursor).toBeInstanceOf(ValidationError);
      expect((failure as ValidationError).message).toBe("Ссылка на страницу устарела — откройте ленту заново");
    }
    expect(repository.reads).toBe(0);
  });

  it("лишняя строка — признак следующей страницы: показано ровно limit, курсор — по последней показанной", async () => {
    const { feed, repository } = setup();
    const rows = [1, 2, 3, 4].map((n) => purchase({ purchaseId: `0000000${String(n)}-0000-4000-8000-000000000000`, invoicedAt: at(10 - n) }));
    repository.rows = rows.map(feedRow);

    const page = await feed.page(ACTOR, filters(), null, 3);

    expect(page.rows.map((row) => row.purchase.purchaseId)).toEqual(rows.slice(0, 3).map((row) => row.purchaseId));
    expect(page.next).not.toBeNull();
    expect(Buffer.from(page.next ?? "", "base64url").toString("utf8")).toBe(`${at(7).toISOString()}|00000003-0000-4000-8000-000000000000`);
  });

  it("курсор со страницы возвращается в репозиторий как есть; последняя страница — next: null", async () => {
    const { feed, repository } = setup();
    repository.rows = [1, 2, 3, 4].map((n) => feedRow(purchase({ purchaseId: `0000000${String(n)}-0000-4000-8000-000000000000`, invoicedAt: at(10 - n) })));
    const first = await feed.page(ACTOR, filters(), null, 3);
    repository.rows = repository.rows.slice(3);

    const last: FeedPage = await feed.page(ACTOR, filters(), first.next, 3);

    expect(repository.queries[1]?.cursor).toEqual({ invoicedAt: at(7), purchaseId: "00000003-0000-4000-8000-000000000000" });
    expect(last.rows).toHaveLength(1);
    expect(last.next).toBeNull();
  });

  it("фильтры, размер страницы и товары с выдачей уходят в репозиторий", async () => {
    const { feed, repository } = setup();
    const query = filters({ status: "undelivered", product: "vip", from: at(1), to: at(9), accountId: ACCOUNT_ID, platform: "vk", mode: "live", search: { chargeId: "stx-123456789" } });

    await feed.page(ACTOR, query, null, 20);

    expect(repository.queries[0]).toEqual({ ...query, fulfillable: ["shop_item", "vip"], cursor: null, limit: 20 });
  });

  it("у строки — игрок и пометки; пометки источников запрашиваются одним вызовом на страницу", async () => {
    const { feed, repository, sources } = setup();
    const [a, b] = [purchase({ purchaseId: randomUUID() }), purchase({ purchaseId: randomUUID(), invoicedAt: at(-5) })];
    repository.rows = [feedRow(a), feedRow(b)];
    const marks = vi.fn(async (ids: readonly string[]) => new Map<string, readonly FeedMark[]>([[ids[0] ?? "", ["discrepancy"]]]));
    sources.register("сверка", { timeline: async () => [], marks, actions: async () => [] });

    const page = await feed.page(ACTOR, filters(), null, 50);

    expect(marks).toHaveBeenCalledTimes(1);
    expect(marks).toHaveBeenCalledWith([a.purchaseId, b.purchaseId]);
    expect(page.rows[0]).toEqual({ purchase: a, account: { accountId: ACCOUNT_ID, displayName: "Стрелок", platform: "telegram" }, marks: ["discrepancy"] });
    expect(page.rows[1]?.marks).toEqual([]);
  });

  it("в ленте нет ни идентификатора игрока на площадке, ни юзернейма", async () => {
    const { feed, repository } = setup();
    repository.rows = [feedRow(purchase())];

    const page = await feed.page(ACTOR, filters(), null, 50);

    expect(JSON.stringify(page)).not.toContain("platformUserId");
    expect(JSON.stringify(page)).not.toContain("username");
  });
});

describe("PaymentsFeed.card: карточка платежа", () => {
  it("без payments.view — отказ", async () => {
    const { feed, repository } = setup(["payments.support"]);
    repository.put(paid());

    await expect(feed.card(ACTOR, PURCHASE_ID)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("нет покупки — PurchaseNotFoundError", async () => {
    const { feed } = setup();

    await expect(feed.card(ACTOR, randomUUID())).rejects.toBeInstanceOf(PurchaseNotFoundError);
  });

  it("покупка, игрок, хронология и действия в одном ответе", async () => {
    const { feed, repository } = setup();
    const row = repository.put(paid({ fulfilledAt: null }));

    const card = await feed.card(ACTOR, PURCHASE_ID);

    expect(card.purchase).toEqual(row);
    expect(card.account).toEqual({ accountId: ACCOUNT_ID, displayName: "Стрелок", platform: "telegram", pii: { platformUserId: "555000111", username: "strelok" } });
    expect(card.renewalOf).toBeNull();
    expect(card.renewals).toEqual([]);
    expect(card.marks).toEqual([]);
    expect(card.timeline.map((line) => line.kind)).toEqual(["invoice", "paid"]);
    expect(card.actions).toEqual(["fulfill", "refund"]);
  });

  it("без players.pii.view — pii: null и нет записи players.pii.view; с правом — запись есть", async () => {
    const without = setup(["payments.view", "payments.support", "audit.view"]);
    without.repository.put(paid());
    const withPii = setup();
    withPii.repository.put(paid());

    const hidden = await without.feed.card(ACTOR, PURCHASE_ID);
    const shown = await withPii.feed.card(ACTOR, PURCHASE_ID);

    expect(hidden.account.pii).toBeNull();
    expect(JSON.stringify(hidden)).not.toContain("555000111");
    expect(JSON.stringify(hidden)).not.toContain("strelok");
    expect(without.roles.audits.filter((record) => record.action === "players.pii.view")).toEqual([]);
    expect(shown.account.pii).toEqual({ platformUserId: "555000111", username: "strelok" });
    expect(withPii.roles.audits).toEqual([{ actorAccountId: ACTOR.accountId, action: "players.pii.view", target: ACCOUNT_ID }]);
  });

  it("продление: ссылка на первую покупку; первая подписка: список продлений", async () => {
    const { feed, repository } = setup();
    const first = repository.put(paid({ product: "vip", sku: "vip" }));
    const renewal = repository.put(paid({ purchaseId: randomUUID(), product: "vip", sku: "vip", renewalOf: first.purchaseId, invoicedAt: at(60), paidAt: at(60) }));

    const ofRenewal = await feed.card(ACTOR, renewal.purchaseId);
    const ofFirst = await feed.card(ACTOR, first.purchaseId);

    expect(ofRenewal.renewalOf).toEqual(first);
    expect(ofRenewal.renewals).toEqual([]);
    expect(ofFirst.renewalOf).toBeNull();
    expect(ofFirst.renewals).toEqual([renewal]);
    expect(ofFirst.timeline.map((line) => line.kind)).toContain("renewal");
  });

  it("разовая покупка продлений не ищет", async () => {
    const { feed, repository } = setup();
    repository.put(paid());
    const readsBefore = repository.reads;

    await feed.card(ACTOR, PURCHASE_ID);

    expect(repository.reads - readsBefore).toBe(1);
  });

  it("хронология — из покупки, журнала команды и источников, по времени", async () => {
    const { feed, repository, roles, sources } = setup();
    repository.put(paid({ fulfilledAt: at(2) }));
    roles.records = [
      { entryId: randomUUID(), createdAt: at(40), actorAccountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", action: "payments.fulfill", target: ACCOUNT_ID, after: { purchaseId: PURCHASE_ID, note: "вручную" } },
      { entryId: randomUUID(), createdAt: at(41), actorAccountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", action: "payments.refund", target: ACCOUNT_ID, after: { purchaseId: randomUUID(), note: "по другой покупке" } },
    ];
    sources.register("сверка", { timeline: async () => [{ at: at(20), kind: "discrepancy", text: "Расхождение со сверкой", actorName: null }], marks: async () => new Map([[PURCHASE_ID, ["discrepancy"]]]), actions: async () => [] });

    const card = await feed.card(ACTOR, PURCHASE_ID);

    expect(card.timeline.map((line) => `${line.kind}:${line.text}`)).toEqual([
      "invoice:Счёт выставлен: 50 ⭐",
      "paid:Оплата записана: списано 50 ⭐",
      "fulfilled:Товар выдан",
      "discrepancy:Расхождение со сверкой",
      "team:Повторная выдача — вручную",
    ]);
    expect(card.timeline.at(-1)?.actorName).toBe("Анна из поддержки");
    expect(card.marks).toEqual(["discrepancy"]);
    expect(roles.auditQueries[0]?.query).toEqual({ limit: 100, before: null, actions: ["payments."], actorAccountId: null, target: ACCOUNT_ID });
  });

  it("без audit.view — хронология без строк команды, не ошибка; журнал не читается", async () => {
    const { feed, repository, roles } = setup(["payments.view", "payments.support", "players.pii.view"]);
    repository.put(paid());
    roles.records = [{ entryId: randomUUID(), createdAt: at(40), actorAccountId: null, action: "payments.fulfill", target: ACCOUNT_ID, after: { purchaseId: PURCHASE_ID } }];

    const card = await feed.card(ACTOR, PURCHASE_ID);

    expect(card.timeline.map((line) => line.kind)).toEqual(["invoice", "paid"]);
    expect(roles.auditQueries).toEqual([]);
  });

  it("действия: без payments.compensate компенсации нет; порядок — fulfill, retry, refund, compensate", async () => {
    const full = setup();
    full.repository.put(paid({ fulfilledAt: null }));
    full.sources.register("а", { timeline: async () => [], marks: async () => new Map(), actions: async () => ["compensate", "retry"] });
    const noCompensate = setup(["payments.view", "payments.support", "players.pii.view", "audit.view"]);
    noCompensate.repository.put(paid({ fulfilledAt: null }));
    noCompensate.sources.register("а", { timeline: async () => [], marks: async () => new Map(), actions: async () => ["compensate", "retry"] });

    expect((await full.feed.card(ACTOR, PURCHASE_ID)).actions).toEqual(["fulfill", "retry", "refund", "compensate"]);
    expect((await noCompensate.feed.card(ACTOR, PURCHASE_ID)).actions).toEqual(["fulfill", "retry", "refund"]);
  });

  it("только просмотр — действий нет вовсе", async () => {
    const { feed, repository, sources } = setup(["payments.view"]);
    repository.put(paid({ fulfilledAt: null }));
    sources.register("а", { timeline: async () => [], marks: async () => new Map(), actions: async () => ["retry", "compensate"] });

    expect((await feed.card(ACTOR, PURCHASE_ID)).actions).toEqual([]);
  });

  it("то же действие от поддержки и от источника — одно", async () => {
    const { feed, repository, sources } = setup();
    repository.put(paid({ fulfilledAt: null }));
    sources.register("а", { timeline: async () => [], marks: async () => new Map(), actions: async () => ["refund", "retry"] });

    expect((await feed.card(ACTOR, PURCHASE_ID)).actions).toEqual(["fulfill", "retry", "refund"]);
  });

  it("упавший источник не ломает карточку", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { feed, repository, sources } = setup();
    repository.put(paid());
    sources.register("падает", {
      timeline: async () => Promise.reject(new Error("сбой")),
      marks: async () => Promise.reject(new Error("сбой")),
      actions: async () => Promise.reject(new Error("сбой")),
    });

    const card = await feed.card(ACTOR, PURCHASE_ID);

    expect(card.timeline.map((line) => line.kind)).toEqual(["invoice", "paid"]);
    expect(card.marks).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe("paymentsFeedQuerySchema: разбор запроса ленты", () => {
  const parse = (query: unknown) => paymentsFeedQuerySchema.parse(query);

  it("пустой запрос — по умолчанию 50 на страницу", () => {
    expect(parse({}).limit).toBe(50);
    expect(feedFiltersOf(parse({}))).toEqual(filters());
  });

  it("перечисления: пять состояний, товары, площадки и режимы; чужое значение — ошибка", () => {
    for (const status of ["pending", "paid", "undelivered", "refund_requested", "refunded"]) expect(parse({ status }).status).toBe(status);
    for (const product of ["continue_run", "shop_item", "vip", "donation"]) expect(parse({ product }).product).toBe(product);
    for (const platform of ["telegram", "max", "vk", "web"]) expect(parse({ platform }).platform).toBe(platform);
    for (const mode of ["live", "test"]) expect(parse({ mode }).mode).toBe(mode);
    for (const bad of [{ status: "done" }, { product: "gold" }, { platform: "icq" }, { mode: "demo" }]) expect(() => parse(bad)).toThrow();
  });

  it("лишний параметр — ошибка: схема строгая", () => {
    expect(() => parse({ sort: "asc" })).toThrow();
  });

  it("limit: от 1 до 100, строка приводится к числу", () => {
    expect(parse({ limit: "25" }).limit).toBe(25);
    for (const limit of ["0", "101", "1.5", "abc"]) expect(() => parse({ limit }), limit).toThrow();
  });

  it("from и to — моменты с поясом; to позже from; границы приходят датами", () => {
    const query = parse({ from: "2026-11-01T00:00:00Z", to: "2026-11-11T21:00:00+03:00" });

    expect(feedFiltersOf(query)).toMatchObject({ from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-11T18:00:00Z") });
    expect(() => parse({ from: "2026-11-11T00:00:00Z", to: "2026-11-11T00:00:00Z" })).toThrow();
    expect(() => parse({ from: "2026-11-12T00:00:00Z", to: "2026-11-11T00:00:00Z" })).toThrow();
    expect(() => parse({ from: "вчера" })).toThrow();
    expect(() => parse({ from: "2026-11-11" })).toThrow();
  });

  it("account — UUID", () => {
    expect(feedFiltersOf(parse({ account: ACCOUNT_ID })).accountId).toBe(ACCOUNT_ID);
    expect(() => parse({ account: "не-uuid" })).toThrow();
  });

  it("q: UUID — поиск по покупке, иначе — по идентификатору оплаты; пробелы по краям срезаются", () => {
    expect(feedFiltersOf(parse({ q: PURCHASE_ID })).search).toEqual({ purchaseId: PURCHASE_ID });
    expect(feedFiltersOf(parse({ q: `  ${PURCHASE_ID}  ` })).search).toEqual({ purchaseId: PURCHASE_ID });
    expect(feedFiltersOf(parse({ q: " stx_0123456789abcdef " })).search).toEqual({ chargeId: "stx_0123456789abcdef" });
    expect(feedFiltersOf(parse({ q: "x".repeat(256) })).search).toEqual({ chargeId: "x".repeat(256) });
  });

  it("q: короче 8 и длиннее 256 знаков — ошибка", () => {
    expect(() => parse({ q: "short" })).toThrow();
    expect(() => parse({ q: "       x       " })).toThrow();
    expect(() => parse({ q: "x".repeat(257) })).toThrow();
  });

  it("cursor — от 1 до 300 знаков и приходит как есть", () => {
    expect(parse({ cursor: "abc" }).cursor).toBe("abc");
    expect(() => parse({ cursor: "" })).toThrow();
    expect(() => parse({ cursor: "x".repeat(301) })).toThrow();
  });
});

describe("AdminPaymentsController: маршруты", () => {
  const request = { account: ACTOR };

  function controller() {
    const calls: { method: string; args: unknown[] }[] = [];
    const page: FeedPage = { rows: [], next: "курсор" };
    const feed = {
      page: async (...args: unknown[]) => {
        calls.push({ method: "page", args });
        return page;
      },
      card: async (...args: unknown[]) => {
        calls.push({ method: "card", args });
        return { purchase: purchase() };
      },
    } as unknown as PaymentsFeed;
    return { controller: new AdminPaymentsController(feed), calls, page };
  }

  it("оба маршрута — под payments.view", () => {
    expect(Reflect.getMetadata(PERMISSION_METADATA, AdminPaymentsController.prototype.list)).toBe("payments.view");
    expect(Reflect.getMetadata(PERMISSION_METADATA, AdminPaymentsController.prototype.card)).toBe("payments.view");
  });

  it("список: фильтры, курсор и размер страницы доходят до сервиса, ответ — в { data }", async () => {
    const { controller: routes, calls, page } = controller();

    const response = await routes.list(request, { status: "paid", q: PURCHASE_ID, cursor: "курсор", limit: "10" });

    expect(response).toEqual({ data: page });
    expect(calls[0]?.method).toBe("page");
    expect(calls[0]?.args).toEqual([ACTOR, filters({ status: "paid", search: { purchaseId: PURCHASE_ID } }), "курсор", 10]);
  });

  it("список: кривой фильтр — 400 с текстом про ленту платежей", async () => {
    const { controller: routes, calls } = controller();

    for (const query of [{ status: "всё" }, { limit: "1000" }, { лишнее: "1" }]) {
      const failure = await routes.list(request, query).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ValidationError);
      expect((failure as ValidationError).message).toBe("Неверный фильтр ленты платежей");
    }
    expect(calls).toEqual([]);
  });

  it("карточка: идентификатор — UUID, иначе 400; ответ — в { data }", async () => {
    const { controller: routes, calls } = controller();

    const response = await routes.card(request, PURCHASE_ID);
    const failure = await routes.card(request, "не-uuid").catch((error: unknown) => error);

    expect(response).toEqual({ data: { purchase: purchase() } });
    expect(calls).toEqual([{ method: "card", args: [ACTOR, PURCHASE_ID] }]);
    expect(failure).toBeInstanceOf(ValidationError);
    expect((failure as ValidationError).message).toBe("Некорректный идентификатор покупки");
  });
});
