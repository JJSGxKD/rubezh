import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import {
  FEED_STATUSES,
  PLATFORMS,
  PRODUCTS,
  feedPageSchema,
  fetchPaymentCard,
  fetchPaymentsFeed,
  markLabel,
  paymentCardSchema,
  retryPayment,
} from "../src/api/payments";
import { EMPTY_FEED_FILTERS, feedChips, feedQuery, filtersFromAccount, isPurchaseId, searchProblem, type FeedFilters } from "../src/screens/payments/feed-filters";
import { fakeFetch, json } from "./helpers";

// Раздел «Платежи» (tasks/T-0437): правила фильтров ленты и разбор ответов сервера T-0429 и T-0431.

const PURCHASE = {
  purchaseId: "3f0c2a52-9d5b-4a79-8a41-0b2a1f6e8c11",
  accountId: "8f7c1c1e-7f0a-4b8e-9d7e-1c2b3a4d5e6f",
  product: "shop_item",
  runId: null,
  continueNo: null,
  elapsedSec: null,
  sku: "gems_small",
  priceStars: 50,
  chargedStars: 50,
  mode: "live",
  status: "paid",
  telegramChargeId: "x".repeat(131),
  invoicedAt: "2026-11-11T09:00:00.000Z",
  paidAt: "2026-11-11T09:01:00.000Z",
  refundReason: null,
  refundRequestedAt: null,
  refundedAt: null,
  fulfilledAt: null,
  renewalOf: null,
};

const ROW = { purchase: PURCHASE, account: { accountId: PURCHASE.accountId, displayName: "Лиса", platform: "telegram" }, marks: ["job_abandoned"] };

const CARD = {
  purchase: PURCHASE,
  account: { accountId: PURCHASE.accountId, displayName: "Лиса", platform: "telegram", pii: { platformUserId: "123456", username: "fox" } },
  renewalOf: null,
  renewals: [],
  timeline: [
    { at: "2026-11-11T09:00:00.000Z", kind: "invoice", text: "Счёт выставлен", actorName: null },
    { at: "2026-11-11T09:05:00.000Z", kind: "team", text: "Выдача повторена", actorName: "Админ" },
  ],
  actions: ["fulfill", "retry", "refund"],
  marks: ["job_abandoned"],
};

const filters = (patch: Partial<FeedFilters>): FeedFilters => ({ ...EMPTY_FEED_FILTERS, ...patch });
const labels = (patch: Partial<FeedFilters>): string[] => feedChips(filters(patch)).map((chip) => chip.label);

describe("запрос ленты", () => {
  it("пустые фильтры — без параметров", () => {
    expect(feedQuery(EMPTY_FEED_FILTERS)).toEqual({});
  });

  it("все фильтры — параметры с теми же именами, что у сервера", () => {
    const query = feedQuery(
      filters({ status: "undelivered", product: "vip", platform: "telegram", mode: "test", from: "2026-11-01", to: "2026-11-11", account: PURCHASE.accountId, accountName: "Лиса", q: "abcdefgh" }),
    );
    expect(Object.keys(query).sort()).toEqual(["account", "from", "mode", "platform", "product", "q", "status", "to"]);
    expect(query).toMatchObject({ status: "undelivered", product: "vip", platform: "telegram", mode: "test", account: PURCHASE.accountId, q: "abcdefgh" });
    // Период — по дате счёта: «по» включает день целиком, граница — полночь следующего дня.
    expect(query["from"]).toBe(new Date(2026, 10, 1).toISOString());
    expect(query["to"]).toBe(new Date(2026, 10, 12).toISOString());
  });

  it("поиск с пробелами по краям обрезан, имя игрока на сервер не уходит", () => {
    const query = feedQuery(filters({ q: "  abcdefgh  ", account: PURCHASE.accountId, accountName: "Лиса" }));
    expect(query["q"]).toBe("abcdefgh");
    expect(Object.values(query)).not.toContain("Лиса");
    expect(feedQuery(filters({ q: "   " }))).toEqual({});
  });
});

describe("чипы фильтров ленты", () => {
  it("пустые фильтры — чипов нет", () => {
    expect(labels({})).toEqual([]);
  });

  it("подписи дословно", () => {
    expect(labels({ status: "undelivered" })).toEqual(["Состояние: не выдан"]);
    expect(labels({ product: "vip" })).toEqual(["Товар: VIP"]);
    expect(labels({ platform: "telegram" })).toEqual(["Площадка: Telegram"]);
    expect(labels({ mode: "test" })).toEqual(["Режим: тестовый"]);
    expect(labels({ mode: "live" })).toEqual(["Режим: боевой"]);
    expect(labels({ from: "2026-11-01", to: "2026-11-11" })).toEqual(["Период: 01.11–11.11"]);
    expect(labels({ from: "2026-11-01" })).toEqual(["Период: с 01.11"]);
    expect(labels({ to: "2026-11-11" })).toEqual(["Период: по 11.11"]);
    expect(labels({ account: "a1", accountName: "Лиса" })).toEqual(["Игрок: Лиса"]);
  });

  it("поиск чипом не показывается: у него своё поле", () => {
    expect(labels({ q: "abcdefgh" })).toEqual([]);
  });

  it("снятие чипа убирает ровно свой фильтр", () => {
    const all = filters({ status: "paid", product: "vip", platform: "max", mode: "test", from: "2026-11-01", to: "2026-11-11", account: "a1", accountName: "Лиса", q: "abcdefgh" });
    const chips = feedChips(all);
    expect(chips.map((chip) => chip.key)).toEqual(["status", "product", "platform", "mode", "period", "account"]);
    const cleared = (key: string) => chips.find((chip) => chip.key === key)?.clear(all);
    expect(cleared("status")).toEqual({ ...all, status: "" });
    expect(cleared("product")).toEqual({ ...all, product: "" });
    expect(cleared("platform")).toEqual({ ...all, platform: "" });
    expect(cleared("mode")).toEqual({ ...all, mode: "" });
    expect(cleared("period")).toEqual({ ...all, from: "", to: "" });
    expect(cleared("account")).toEqual({ ...all, account: "", accountName: "" });
  });

  it("фильтр по игроку из ссылки карточки игрока", () => {
    expect(filtersFromAccount("a1", "Лиса")).toEqual({ ...EMPTY_FEED_FILTERS, account: "a1", accountName: "Лиса" });
  });
});

describe("поиск по ленте", () => {
  it("1–7 знаков — подсказка, 8 и больше — можно, пусто — можно", () => {
    const text = "Номер покупки или идентификатор оплаты — от 8 знаков";
    expect(searchProblem("abc")).toBe(text);
    expect(searchProblem("1234567")).toBe(text);
    expect(searchProblem("  abc  ")).toBe(text);
    expect(searchProblem("12345678")).toBeNull();
    expect(searchProblem("  12345678  ")).toBeNull();
    expect(searchProblem("")).toBeNull();
    expect(searchProblem("   ")).toBeNull();
  });

  it("карточка открывается только по UUID: слова вкладок — это лента", () => {
    expect(isPurchaseId(PURCHASE.purchaseId)).toBe(true);
    expect(isPurchaseId("3F0C2A52-9D5B-4A79-8A41-0B2A1F6E8C11")).toBe(true);
    expect(isPurchaseId("discrepancies")).toBe(false);
    expect(isPurchaseId("jobs")).toBe(false);
    expect(isPurchaseId(null)).toBe(false);
  });
});

describe("подписи и пометки", () => {
  it("состояния, товары и площадки — словами", () => {
    expect(Object.fromEntries(FEED_STATUSES)).toEqual({
      pending: "ждёт оплаты",
      paid: "оплачен",
      undelivered: "не выдан",
      refund_requested: "возврат в пути",
      refunded: "звёзды возвращены",
    });
    expect(Object.fromEntries(PRODUCTS)).toEqual({ continue_run: "второй шанс", shop_item: "магазин", vip: "VIP", donation: "донат" });
    expect(Object.fromEntries(PLATFORMS)).toEqual({ telegram: "Telegram", max: "MAX", vk: "VK", web: "веб" });
  });

  it("пометки: подписи и тоны; незнакомая — как есть, без тона", () => {
    expect(markLabel("compensated")).toEqual({ label: "компенсирована", tone: "success" });
    expect(markLabel("job_abandoned")).toEqual({ label: "задание брошено", tone: "warning" });
    expect(markLabel("discrepancy")).toEqual({ label: "расхождение", tone: "warning" });
    expect(markLabel("something_new")).toEqual({ label: "something_new", tone: "neutral" });
  });
});

describe("разбор ответов сервера", () => {
  it("страница ленты разбирается, лишнее поле не ломает", () => {
    const page = feedPageSchema.parse({ rows: [{ ...ROW, extra: 1 }], next: null, newField: true });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.marks).toEqual(["job_abandoned"]);
    expect(page.rows[0]?.purchase.telegramChargeId).toHaveLength(131);
    expect(page.next).toBeNull();
  });

  it("карточка разбирается: хронология, действия, пометки", () => {
    const card = paymentCardSchema.parse({ ...CARD, extra: "x" });
    expect(card.account.pii).toEqual({ platformUserId: "123456", username: "fox" });
    expect(card.timeline.map((entry) => entry.kind)).toEqual(["invoice", "team"]);
    expect(card.timeline[1]?.actorName).toBe("Админ");
    expect(card.actions).toEqual(["fulfill", "retry", "refund"]);
  });

  it("карточка без pii — pii: null", () => {
    expect(paymentCardSchema.parse({ ...CARD, account: { ...CARD.account, pii: null } }).account.pii).toBeNull();
    const { pii: _pii, ...bare } = CARD.account;
    expect(paymentCardSchema.parse({ ...CARD, account: bare }).account.pii).toBeNull();
  });

  it("действие и пометка новее панели — строки, а не ошибка разбора", () => {
    const card = paymentCardSchema.parse({ ...CARD, actions: ["compensate", "brand_new"], marks: ["brand_new"] });
    expect(card.actions).toEqual(["compensate", "brand_new"]);
  });

  it("изменившийся тип поля — ошибка разбора", () => {
    expect(feedPageSchema.safeParse({ rows: [{ ...ROW, marks: "x" }], next: null }).success).toBe(false);
  });
});

describe("вызовы API", () => {
  it("лента: параметры и курсор уходят в запрос, ответ разбирается", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { rows: [ROW], next: "cur" } }));
    const result = await fetchPaymentsFeed(new AdminApi(fetch), feedQuery(filters({ status: "paid", q: " abcdefgh " })), "cursor-1");
    expect(result.ok && result.data.next).toBe("cur");
    const url = new URL(calls[0]?.url ?? "", "http://x");
    expect(url.pathname).toBe("/api/v1/admin/payments");
    expect(url.searchParams.get("status")).toBe("paid");
    expect(url.searchParams.get("q")).toBe("abcdefgh");
    expect(url.searchParams.get("cursor")).toBe("cursor-1");
  });

  it("карточка: адрес с номером покупки; 404 — не найдено", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: CARD }), json(404, { error: { code: "purchase_not_found", message: "Покупка не найдена" } }));
    const api = new AdminApi(fetch);
    expect((await fetchPaymentCard(api, PURCHASE.purchaseId)).ok).toBe(true);
    expect(calls[0]?.url).toBe(`/api/v1/admin/payments/${PURCHASE.purchaseId}`);
    const missing = await fetchPaymentCard(api, PURCHASE.purchaseId);
    expect(!missing.ok && missing.error.kind).toBe("not_found");
  });

  it("повтор учёта: POST с причиной по адресу покупки", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { retried: ["confirm-1"] } }));
    const result = await retryPayment(new AdminApi(fetch), PURCHASE.purchaseId, "ошибка записи");
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe(`/api/v1/admin/payments/${PURCHASE.purchaseId}/retry`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ note: "ошибка записи" });
  });
});
