import { beforeEach, describe, expect, it } from "vitest";
import type { InvoiceStatus } from "@bh/shared-types";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { useShell } from "../src/state/shell";
import { createShopApi, isDelivered, type ShopInvoice, type ShopPurchaseState } from "../src/state/shop-api";
import { buy, CONFIRM_POLL_MS, CONFIRM_TIMEOUT_MS, type BuyDeps, type BuyRequest } from "../src/state/shop-purchase";
import { itemName, noticeOf } from "../src/screens/meta/shop-texts";

// Магазин и VIP на клиенте (docs/35-stage4-plan.md WP10): витрина и VIP — с
// сервера, схемой, цены в запросе нет; купленным товар считается, когда
// сервер сказал, что он на счету, а не окно оплаты.

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

function server(sent: Sent[], answer: unknown): ApiRequest {
  return async <T,>(path: string, schema: object, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>> => {
    sent.push({ method: init?.method ?? "GET", path, body: init?.body });
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
    return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
  };
}

const SHOP = {
  items: [
    { sku: "starter", kind: "starter", contents: [{ resource: "coins", amount: 3000 }, { resource: "gems", amount: 60 }], stars: 50, chargedStars: 50, once: true, owned: false },
    { sku: "gems_60", kind: "gems", contents: [{ resource: "gems", amount: 60 }], stars: 50, chargedStars: 50, once: false, owned: false },
  ],
  payable: true,
  mode: "live",
};

const VIP = {
  active: true,
  until: "2026-10-30T09:00:00.000Z",
  renewal: "on",
  canResume: false,
  canOrder: false,
  stars: 200,
  chargedStars: 200,
  mode: "live",
  sku: "vip_month",
  periodDays: 30,
  daily: { gems: 10, claimed: false },
};

const INVOICE: ShopInvoice = { purchaseId: "p-1", sku: "gems_60", status: "pending", invoiceUrl: "https://t.me/$invoice", priceStars: 50, chargedStars: 50, mode: "live" };

describe("клиент магазина", () => {
  it("витрина и VIP — GET, счёт — POST только с товаром, VIP и его действия — POST без тела", async () => {
    const sent: Sent[] = [];
    const shop = createShopApi(server(sent, SHOP));
    expect((await shop.view()).ok).toBe(true);
    await shop.order("gems_60");
    await createShopApi(server(sent, VIP)).vip();
    await shop.orderVip();
    await shop.cancelVip();
    await shop.resumeVip();
    await shop.claimVipDaily();
    await shop.purchase("p/1");

    expect(sent).toEqual([
      { method: "GET", path: "/api/v1/shop", body: undefined },
      { method: "POST", path: "/api/v1/shop/orders", body: { sku: "gems_60" } },
      { method: "GET", path: "/api/v1/vip", body: undefined },
      { method: "POST", path: "/api/v1/vip/orders", body: undefined },
      { method: "POST", path: "/api/v1/vip/cancel", body: undefined },
      { method: "POST", path: "/api/v1/vip/resume", body: undefined },
      { method: "POST", path: "/api/v1/vip/daily", body: undefined },
      { method: "GET", path: "/api/v1/payments/p%2F1", body: undefined },
    ]);
  });

  it("незнакомый товар и ресурс сервера новее клиента принимаются; сервер без режима и списания — тоже", async () => {
    const newer = { ...SHOP, items: [...SHOP.items, { sku: "crystal_box", kind: "crystals", contents: [{ resource: "crystals", amount: 5 }], stars: 70, once: false, owned: false }] };
    // Сервер до режима оплаты его не присылал.
    const older = { items: newer.items, payable: newer.payable };
    const view = await createShopApi(server([], older)).view();
    expect(view.ok && view.data.items.map((item) => item.sku)).toEqual(["starter", "gems_60", "crystal_box"]);
  });

  it("ответ не по схеме — отказ, а не пустая витрина", async () => {
    expect((await createShopApi(server([], { items: [{ sku: "x" }], payable: true })).view()).ok).toBe(false);
    expect((await createShopApi(server([], { ...VIP, daily: null })).vip()).ok).toBe(false);
  });

  it("товар дошёл, когда лёг на счёт; сервер до магазина говорил только об оплате", () => {
    expect(isDelivered({ purchaseId: "p", status: "paid", granted: true, fulfilled: false })).toBe(false);
    expect(isDelivered({ purchaseId: "p", status: "paid", granted: true, fulfilled: true })).toBe(true);
    expect(isDelivered({ purchaseId: "p", status: "paid", granted: true })).toBe(true);
  });

  it("имя товара — из словаря, незнакомый называется составом", () => {
    expect(itemName({ sku: "starter", contents: [] })).toBe("Стартовый набор");
    expect(itemName({ sku: "crystal_box", contents: [{ resource: "gems", amount: 5 }, { resource: "crystals", amount: 2 }] })).toBe("5 самоцветов, 2");
  });
});

describe("покупка в магазине", () => {
  let events: { event: string; payload: Record<string, unknown> }[];
  let clock: number;
  let polled: string[];
  let delivered: boolean;
  let opened: string[];

  function deps(status: InvoiceStatus | "none" = "paid"): BuyDeps {
    return {
      api: {
        purchase: async (purchaseId: string): Promise<ApiResult<ShopPurchaseState>> => {
          polled.push(purchaseId);
          return { ok: true, data: { purchaseId, status: "paid", granted: true, fulfilled: delivered } };
        },
      },
      openInvoice:
        status === "none"
          ? undefined
          : async (url: string) => {
              opened.push(url);
              return status;
            },
      wait: async (ms) => {
        clock += ms;
        // Сервер выдаёт к третьему опросу — как очередь подтверждения после оплаты.
        if (polled.length >= 2) delivered = true;
      },
      now: () => clock,
    };
  }

  function request(answer: ApiResult<ShopInvoice> = { ok: true, data: INVOICE }): BuyRequest {
    return { product: "shop_item", sku: "gems_60", priceStars: 50, chargedStars: 50, mode: "live", order: async () => answer };
  }

  const named = (name: string) => events.filter((entry) => entry.event === name).map((entry) => entry.payload);

  beforeEach(() => {
    events = [];
    clock = 0;
    polled = [];
    delivered = false;
    opened = [];
    useShell.setState({ analytics: (event, payload) => void events.push({ event, payload: payload ?? {} }) });
  });

  it("окно сказало «оплачено» — ждём, пока сервер положит товар, и только тогда готово", async () => {
    expect(await buy(request(), deps("paid"))).toEqual({ kind: "done" });
    expect(opened).toEqual([INVOICE.invoiceUrl]);
    expect(polled).toEqual(["p-1", "p-1", "p-1"]);
    expect(named("purchase_initiated")).toEqual([{ product: "shop_item", sku: "gems_60", priceStars: 50, chargedStars: 50, mode: "live" }]);
    expect(named("purchase_completed")).toHaveLength(1);
  });

  it("событие несёт цену и режим из счёта, а не из витрины: тестовая оплата не смешается с настоящей", async () => {
    await buy(request({ ok: true, data: { ...INVOICE, chargedStars: 1, mode: "test" } }), deps("paid"));
    expect(named("purchase_completed")).toEqual([{ product: "shop_item", sku: "gems_60", priceStars: 50, chargedStars: 1, mode: "test" }]);
  });

  it("разовый уже оплачен — окно не открывается, ждём выдачи", async () => {
    expect(await buy(request({ ok: true, data: { ...INVOICE, status: "paid", invoiceUrl: null } }), deps("paid"))).toEqual({ kind: "done" });
    expect(opened).toEqual([]);
  });

  it("закрыл окно — отмена без ожидания; оплата не прошла — повтор", async () => {
    expect(await buy(request(), deps("cancelled"))).toEqual({ kind: "cancelled" });
    expect(await buy(request(), deps("failed"))).toEqual({ kind: "retry", reason: "payment_failed" });
    expect(polled).toEqual([]);
    expect(named("purchase_failed").map((payload) => payload.reason)).toEqual(["cancelled", "failed"]);
  });

  it("подтверждение не дождались — «ещё подтверждается», а не ошибка", async () => {
    const slow = deps("paid");
    slow.wait = async (ms) => {
      clock += ms;
    };
    expect(await buy(request(), slow)).toEqual({ kind: "retry", reason: "slow_confirmation" });
    expect(polled.length).toBe(CONFIRM_TIMEOUT_MS / CONFIRM_POLL_MS);
    expect(named("purchase_failed")).toEqual([{ product: "shop_item", sku: "gems_60", priceStars: 50, chargedStars: 50, mode: "live", reason: "timeout" }]);
  });

  it("площадка без окна оплаты — отказ «только в Telegram»", async () => {
    expect(await buy(request(), deps("none"))).toEqual({ kind: "refused", code: "payments_unsupported" });
  });

  it("сеть и недоступная оплата — повтор; отказ по существу — нет, с кодом сервера", async () => {
    expect(await buy(request({ ok: false, failure: "offline" }), deps())).toEqual({ kind: "retry", reason: "offline" });
    expect(await buy(request({ ok: false, failure: "unavailable", code: "payments_unavailable" }), deps())).toEqual({ kind: "retry", reason: "offline" });
    expect(await buy(request({ ok: false, failure: "unavailable", code: "vip_active" }), deps())).toEqual({ kind: "refused", code: "vip_active" });
    expect(await buy(request({ ok: false, failure: "disabled" }), deps())).toEqual({ kind: "refused", code: "disabled" });
    expect(named("purchase_initiated")).toEqual([]);
    expect(named("purchase_failed").map((payload) => payload.reason)).toEqual(["offline", "payments_unavailable", "vip_active", "disabled"]);
  });

  it("исход — в строку для игрока: знакомый отказ своим текстом, незнакомый — общим", () => {
    expect(noticeOf({ kind: "done" }, "Набор кузнеца")).toEqual({ tone: "success", text: "Готово: «Набор кузнеца» на счету." });
    expect(noticeOf({ kind: "cancelled" }, "x")).toBeNull();
    expect(noticeOf({ kind: "refused", code: "vip_active" }, "VIP")?.text).toBe("VIP уже подключён и продлевается.");
    expect(noticeOf({ kind: "refused", code: "something_new" }, "x")?.text).toBe("Покупка не удалась.");
    expect(noticeOf({ kind: "retry", reason: "slow_confirmation" }, "x")?.tone).toBe("error");
  });
});
