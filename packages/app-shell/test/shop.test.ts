import { beforeEach, describe, expect, it } from "vitest";
import type { InvoiceStatus } from "@bh/shared-types";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { useShell } from "../src/state/shell";
import { createShopApi, isDelivered, type ShopInvoice, type ShopPurchaseState, type ShopView, type VipView } from "../src/state/shop-api";
import { buy, CONFIRM_POLL_MS, CONFIRM_TIMEOUT_MS, type BuyDeps, type BuyRequest } from "../src/state/shop-purchase";
import { badgeLabel, bannerKey, buyLabel, itemName, noticeOf, promoLeft, shopBanners, showcaseRefusal, shownPrice, tributeOf, vipWaiting } from "../src/screens/meta/shop-texts";

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

const NOW = Date.UTC(2026, 9, 1, 9);
const HOUR = 3_600_000;

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

describe("подача магазина", () => {
  const view = (patch: Partial<ShopView> = {}): ShopView => ({
    items: [
      { sku: "starter", kind: "starter", contents: [{ resource: "gems", amount: 60 }], stars: 50, once: true, owned: false },
      { sku: "gems_60", kind: "gems", contents: [{ resource: "gems", amount: 60 }], stars: 50, once: false, owned: false, badge: "hit" },
      { sku: "gems_330", kind: "gems", contents: [{ resource: "gems", amount: 330 }], stars: 250, once: false, owned: false, badge: "best", valuePct: 10 },
    ],
    payable: true,
    mode: "live",
    recommended: "gems_330",
    tribute: "https://t.me/tribute/app",
    ...patch,
  });
  const offer: VipView = { ...VIP, renewal: "off", mode: "live", active: false, until: null, canOrder: true, stars: 700 };
  const active: VipView = { ...VIP, renewal: "on", mode: "live" };

  it("баннеры по ценности: VIP, стартовый, подобранный, снаряжение, Tribute", () => {
    expect(shopBanners(view(), offer, NOW).map((banner) => banner.kind)).toEqual(["vip", "starter", "recommended", "gear", "tribute"]);
  });

  it("предлагается только то, что можно купить: идущий VIP, купленный стартовый, подобранный им же — без баннера", () => {
    const owned = view({ items: view().items.map((item) => (item.sku === "starter" ? { ...item, owned: true } : item)), recommended: "starter", tribute: null });
    expect(shopBanners(owned, active, NOW).map((banner) => banner.kind)).toEqual(["gear"]);
    // Подобранный стартовый — уже баннер «Стартовый набор», второй с тем же товаром не нужен.
    expect(shopBanners(view({ recommended: "starter" }), null, NOW).map((banner) => banner.kind)).toEqual(["starter", "gear", "tribute"]);
    // Без цены у способа оплаты продать нельзя — и предлагать тоже.
    expect(shopBanners(view(), { ...offer, stars: null }, NOW).map((banner) => banner.kind)).not.toContain("vip");
  });

  it("акции — первыми в полосе, глубокие раньше, не больше двух; товар по акции второй раз не предлагается", () => {
    const promo = (percent: number) => ({ percent, endsAt: new Date(NOW + HOUR).toISOString(), title: null });
    const items = [
      { sku: "starter", kind: "starter", contents: [{ resource: "gems", amount: 60 }], stars: 25, fullStars: 50, promo: promo(50), once: true, owned: false },
      { sku: "gems_60", kind: "gems", contents: [{ resource: "gems", amount: 60 }], stars: 45, fullStars: 50, promo: promo(10), once: false, owned: false },
      { sku: "gems_330", kind: "gems", contents: [{ resource: "gems", amount: 330 }], stars: 175, fullStars: 250, promo: promo(30), once: false, owned: false },
    ];
    const banners = shopBanners(view({ items }), offer, NOW);
    expect(banners.map(bannerKey)).toEqual(["promo:starter", "promo:gems_330", "vip", "gear", "tribute"]);
    // Кончившаяся на глазах акция из полосы уходит, товар возвращается на своё место.
    expect(shopBanners(view({ items }), offer, NOW + 2 * HOUR).map((banner) => banner.kind)).toEqual(["vip", "starter", "recommended", "gear", "tribute"]);
    // Купленный стартовый по акции не предлагается.
    expect(shopBanners(view({ items: items.map((item) => (item.sku === "starter" ? { ...item, owned: true } : item)) }), null, NOW).map(bannerKey)).toEqual(["promo:gems_330", "promo:gems_60", "gear", "tribute"]);
  });

  it("показанная цена: по акции — со скидкой и зачёркнутой ценой каталога; кончившаяся — цена каталога; без акции — как пришла", () => {
    const item = { sku: "gems_330", kind: "gems", contents: [{ resource: "gems", amount: 330 }], stars: 175, fullStars: 250, promo: { percent: 30, endsAt: new Date(NOW + HOUR).toISOString(), title: null }, once: false, owned: false };
    expect(shownPrice(item, NOW)).toEqual({ stars: 175, full: 250, promo: item.promo });
    expect(shownPrice(item, NOW + HOUR)).toEqual({ stars: 250, full: null, promo: null });
    expect(shownPrice({ ...item, fullStars: null, promo: null, stars: 250 }, NOW)).toEqual({ stars: 250, full: null, promo: null });
    // Сервер до акций полей не присылал.
    expect(shownPrice({ sku: "gems_60", kind: "gems", contents: [], stars: 50, once: false, owned: false }, NOW)).toEqual({ stars: 50, full: null, promo: null });

    expect(promoLeft(item.promo, NOW)).toBe("1 ч");
    expect(buyLabel(item, shownPrice(item, NOW))).toBe("Купить «Мешочек самоцветов» за 175 звёзд вместо 250");
    expect(buyLabel(item, shownPrice(item, NOW + HOUR))).toBe("Купить «Мешочек самоцветов» за 250 звёзд");
  });

  it("витрина с акцией проходит схему; сервер до акций — тоже", async () => {
    const promoted = { ...SHOP, items: [{ ...SHOP.items[1], stars: 35, fullStars: 50, promo: { percent: 30, endsAt: "2026-10-02T09:00:00.000Z", title: "Неделя самоцветов" } }] };
    const view = await createShopApi(server([], promoted)).view();
    expect(view.ok && view.data.items[0]?.promo?.title).toBe("Неделя самоцветов");
    expect((await createShopApi(server([], { ...promoted, items: [{ ...promoted.items[0], promo: { percent: "30" } }] })).view()).ok).toBe(false);
  });

  it("Tribute — только по https: пустая, чужая схема и мусор — без плашки", () => {
    expect(tributeOf({ tribute: "https://t.me/tribute/app" })).toBe("https://t.me/tribute/app");
    expect(tributeOf({ tribute: "http://t.me/tribute" })).toBeNull();
    expect(tributeOf({ tribute: "javascript:alert(1)" })).toBeNull();
    expect(tributeOf({ tribute: "не ссылка" })).toBeNull();
    expect(tributeOf({ tribute: "" })).toBeNull();
    expect(tributeOf({})).toBeNull();
  });

  it("знак на вкладке — самоцветы дня VIP ждут забора", () => {
    expect(vipWaiting(active)).toBe(1);
    expect(vipWaiting({ ...active, daily: { gems: 10, claimed: true } })).toBe(0);
    expect(vipWaiting(offer)).toBe(0);
    expect(vipWaiting(null)).toBe(0);
  });

  it("бейдж словами; незнакомый от сервера новее клиента — без бейджа", () => {
    expect(badgeLabel("hit")).toBe("Хит");
    expect(badgeLabel("best")).toBe("Лучшая цена");
    expect(badgeLabel("sale")).toBeNull();
    expect(badgeLabel(null)).toBeNull();
  });

  it("бейдж и выгода доходят с сервера, а сервер до подачи их не присылал", async () => {
    const shown = await createShopApi(server([], view())).view();
    expect(shown.ok && shown.data.items.map((item) => [item.badge, item.valuePct])).toEqual([[undefined, undefined], ["hit", undefined], ["best", 10]]);
    expect(shown.ok && [shown.data.recommended, shown.data.tribute]).toEqual(["gems_330", "https://t.me/tribute/app"]);
    expect((await createShopApi(server([], SHOP)).view()).ok).toBe(true);
  });
});

describe("витрина снаряжения", () => {
  const OFFER = {
    offerId: "0b6c4b1e-1d8e-4c4f-9a6a-2a0d7b7c9f01",
    slot: "weapon",
    rarity: "legendary",
    level: 6,
    power: 41,
    main: { stat: "damage", value: 0.2 },
    extras: [{ stat: "maxHp", value: 12 }],
    gems: 300,
    sold: false,
  };

  it("витрина — GET, покупка — POST с предложением в адресе и без тела: цену берёт сервер", async () => {
    const sent: Sent[] = [];
    const view = await createShopApi(server(sent, { offers: [OFFER, { ...OFFER, slot: "cape", rarity: "astral", sold: true }] })).showcase();
    expect(view.ok && view.data.offers.map((offer) => [offer.slot, offer.rarity, offer.sold])).toEqual([
      ["weapon", "legendary", false],
      ["cape", "astral", true],
    ]);
    await createShopApi(server(sent, { item: { itemId: "i-1", slot: "weapon", rarity: "legendary", level: 6, power: 41 }, view: { offers: [{ ...OFFER, sold: true }] } })).buyShowcase(OFFER.offerId);
    expect(sent).toEqual([
      { method: "GET", path: "/api/v1/shop/showcase", body: undefined },
      { method: "POST", path: `/api/v1/shop/showcase/${OFFER.offerId}/buy`, body: undefined },
    ]);
  });

  it("предложение без значений свойств — отказ схемы, а не пустая карточка", async () => {
    const broken = await createShopApi(server([], { offers: [{ ...OFFER, main: { stat: "damage" } }] })).showcase();
    expect(broken.ok).toBe(false);
  });

  it("отказ в покупке: мало самоцветов и полный инвентарь — своим текстом; устаревшая витрина — перечитать", () => {
    expect(showcaseRefusal("insufficient_funds")).toEqual({ text: "Не хватает самоцветов", reload: false });
    expect(showcaseRefusal("inventory_full")).toMatchObject({ reload: false, text: expect.stringMatching(/Инвентарь полон/) });
    for (const code of ["showcase_sold", "showcase_expired", "showcase_offer_not_found"]) expect(showcaseRefusal(code)).toMatchObject({ reload: true });
    expect(showcaseRefusal(undefined)).toMatchObject({ reload: false, text: expect.stringMatching(/Не удалось купить/) });
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

  it("покупка по акции несёт скидку в событиях; счёт уже без скидки — акция кончилась — и скидки в событии нет", async () => {
    await buy({ ...request({ ok: true, data: { ...INVOICE, priceStars: 35, chargedStars: 35 } }), priceStars: 35, chargedStars: 35, promoPct: 30 }, deps("paid"));
    expect(named("purchase_completed")).toEqual([{ product: "shop_item", sku: "gems_60", priceStars: 35, chargedStars: 35, mode: "live", promoPct: 30 }]);

    events = [];
    await buy({ ...request(), priceStars: 35, chargedStars: 35, promoPct: 30 }, deps("paid"));
    expect(named("purchase_initiated")).toEqual([{ product: "shop_item", sku: "gems_60", priceStars: 50, chargedStars: 50, mode: "live" }]);
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
