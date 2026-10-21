import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { DisabledError, ValidationError } from "../src/common/domain-error.js";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { parseAmounts, presetsFor } from "../src/modules/donations/donation-amounts.js";
import type { DonationsRepository } from "../src/modules/donations/donations.repository.js";
import { DonationsService } from "../src/modules/donations/donations.service.js";
import { PaymentConfirmation } from "../src/modules/payments/payment-confirmation.js";
import { PaymentRefunds } from "../src/modules/payments/payment-refunds.js";
import { PaymentsHooks } from "../src/modules/payments/payments-hooks.js";
import { PaymentsQueue } from "../src/modules/payments/payments-queue.js";
import { PaymentsUnsupportedError } from "../src/modules/payments/payments-errors.js";
import { PaymentsService } from "../src/modules/payments/payments.service.js";
import { PurchaseFulfillment } from "../src/modules/payments/purchase-fulfillment.js";
import { PurchaseRevocation } from "../src/modules/payments/purchase-revocation.js";
import type { StoredPurchase } from "../src/modules/payments/purchase-types.js";
import type { AccountRef } from "../src/modules/roles/roles.service.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { SETTING_LIST, SETTINGS, type SettingValue } from "../src/modules/settings/setting-catalog.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { FakeStarsApi, starsProviders } from "./helpers/fake-stars-api.js";
import { MemoryPurchasesRepository } from "./helpers/memory-purchases.js";
import { MemoryRestrictionsRepository, restrictionsGate } from "./helpers/memory-restrictions.js";
import { MemoryRunsRepository } from "./helpers/memory-runs.js";
import { switchesOf } from "./helpers/notify-targets.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Донаты проекту (docs/35-stage4-plan.md, Р109, tasks/T-0157): счёт на любую
 * целую сумму в пределах способа оплаты площадки, знак «Поддержал проект» за
 * подтверждённую оплату и его снятие внешним возвратом. SQL знака — на живой
 * базе (`donations.integration.test.ts`), маршруты — `donations.http.test.ts`.
 */

const NOW = Date.UTC(2026, 9, 19, 9);

function config(patch: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, TELEGRAM_BOT_UPDATES: "polling", PAYMENTS_ENABLED: "true", ...patch } as NodeJS.ProcessEnv);
}

function player(platform: AccountRef["platform"] = "telegram", platformUserId = "555000222"): AccountRef {
  return { accountId: randomUUID(), platform, platformUserId };
}

/** Знак в памяти: смысл тот же, что у SQL — первая дата не перезаписывается, донат считается по таблице покупок. */
class MemoryDonations implements DonationsRepository {
  readonly supporters = new Map<string, Date>();

  constructor(private readonly purchases: MemoryPurchasesRepository) {}

  async isSupporter(accountId: string): Promise<boolean> {
    return this.supporters.has(accountId);
  }

  async markSupporter(accountId: string, at: Date): Promise<void> {
    if (!this.supporters.has(accountId)) this.supporters.set(accountId, at);
  }

  async clearSupporterUnlessOther(accountId: string, exceptPurchaseId: string): Promise<boolean> {
    const other = [...this.purchases.rows.values()].some(
      (row) => row.accountId === accountId && row.product === "donation" && row.purchaseId !== exceptPurchaseId && row.status === "paid" && row.refundedAt === null && row.refundRequestedAt === null,
    );
    if (!other) this.supporters.delete(accountId);
    return !other;
  }
}

interface SetupOptions {
  env?: AppConfig;
  /** значения ключей, как их задали бы в панели */
  panel?: Record<string, SettingValue>;
}

function setup(options: SetupOptions = {}) {
  const settings = options.env ?? config();
  const purchases = new MemoryPurchasesRepository();
  const api = new FakeStarsApi();
  const providers = starsProviders(api);
  const payments = new PaymentsService(settings, purchases, new MemoryRunsRepository(), providers, switchesOf(settings));
  const fulfillment = new PurchaseFulfillment();
  const revocation = new PurchaseRevocation();
  const supporters = new MemoryDonations(purchases);
  const restrictions = new MemoryRestrictionsRepository();
  const reader = panelSettings(options.panel);
  const donations = new DonationsService(payments, fulfillment, revocation, supporters, restrictionsGate(restrictions), reader);
  donations.onModuleInit();
  const confirmation = new PaymentConfirmation(settings, purchases, providers, switchesOf(settings), new PaymentsHooks(), revocation);
  const refunds = new PaymentRefunds(purchases, providers, revocation);
  const queue = new PaymentsQueue(settings, confirmation, refunds, new RunsHooks(), providers, fulfillment, purchases);
  return { purchases, api, payments, fulfillment, revocation, supporters, restrictions, donations, confirmation, refunds, queue, reader };
}

/** Площадка подтвердила оплату — задание очереди, как его выполнил бы воркер. */
async function pay(ctx: ReturnType<typeof setup>, purchaseId: string, payer: string, chargeId = `charge-${purchaseId}`): Promise<void> {
  const row = await ctx.purchases.byId(purchaseId);
  if (row === null) throw new Error("нет покупки");
  ctx.purchases.owners.set(row.accountId, payer);
  await ctx.queue.process({ data: { kind: "confirm", payment: { platform: "telegram", chargeId, payload: purchaseId, payerId: payer, currency: "XTR", totalAmount: row.chargedStars } } });
}

/** Оплаченный донат: счёт на сумму и подтверждение. */
async function donated(ctx: ReturnType<typeof setup>, me: AccountRef, amount: number, chargeId?: string): Promise<StoredPurchase> {
  const invoice = await ctx.donations.order(me, amount, new Date(NOW));
  await pay(ctx, invoice.purchaseId, me.platformUserId, chargeId);
  const row = await ctx.purchases.byId(invoice.purchaseId);
  if (row === null) throw new Error("покупки нет");
  return row;
}

describe("разбор сумм", () => {
  it("целые суммы через запятую, пробелы вокруг не мешают", () => {
    expect(parseAmounts("50, 100,250")).toEqual([50, 100, 250]);
    expect(parseAmounts(" 1 ,100000 ")).toEqual([1, 100_000]);
    expect(parseAmounts("5")).toEqual([5]);
    expect(parseAmounts("1, 2, 3, 4, 5, 6, 7, 8")).toHaveLength(8);
  });

  it("пусто, мусор, нуль, дробь, лишняя запятая, больше восьми сумм и свыше предела — не сумма", () => {
    for (const bad of ["", "   ", "abc", "0, 5", "1.5", "-5", "50,", ",50", "50,,100", "50; 100", "1, 2, 3, 4, 5, 6, 7, 8, 9", "100001"]) {
      expect(parseAmounts(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("готовые суммы: вне пределов способа и повторы отбрасываются, остальное — по возрастанию", () => {
    expect(presetsFor("1000, 50, 50, 20000, 5", 1, 10_000)).toEqual([5, 50, 1000]);
    expect(presetsFor("50, 100", 60, 90)).toEqual([]);
    expect(presetsFor("10, 20, 30", 20, 30)).toEqual([20, 30]);
    // Негодное значение не роняет витрину — готовых сумм просто нет.
    expect(presetsFor("мусор", 1, 10_000)).toEqual([]);
  });
});

describe("ключи панели", () => {
  it("группа «Донаты», окружения у ключей нет, умолчания — по Р109", () => {
    const keys = [SETTINGS.donateAmounts, SETTINGS.donateTributeUrlTelegram, SETTINGS.donateTributeUrlWeb, SETTINGS.donateHomeSlide];
    expect(keys.map((setting) => setting.key)).toEqual(["donate.amounts", "donate.tribute-url-telegram", "donate.tribute-url-web", "donate.home-slide"]);
    for (const setting of keys) {
      const listed = SETTING_LIST.find((entry) => entry.key === setting.key);
      expect(listed, setting.key).toBe(setting);
      expect(listed?.group, setting.key).toBe("Донаты");
      expect(listed?.fromEnv(config()), setting.key).toBeNull();
    }
    expect(SETTINGS.donateAmounts.fallback).toBe("50, 100, 250, 500, 1000");
    expect(SETTINGS.donateAmounts.kind).toBe("amounts");
    expect(SETTINGS.donateTributeUrlTelegram.kind).toBe("url");
    expect(SETTINGS.donateTributeUrlTelegram.fallback).toBe("");
    expect(SETTINGS.donateTributeUrlWeb.fallback).toBe("");
    expect(SETTINGS.donateHomeSlide.kind).toBe("boolean");
    expect(SETTINGS.donateHomeSlide.fallback).toBe(false);
  });

  it("суммы: схема принимает то же, что разбор, и отвечает понятным текстом", () => {
    const schema = SETTINGS.donateAmounts.schema;
    expect(schema.safeParse("50, 100, 250").success).toBe(true);
    for (const bad of ["", "abc", "0, 5", "1.5", "1, 2, 3, 4, 5, 6, 7, 8, 9", "100001"]) {
      const result = schema.safeParse(bad);
      expect(result.success, JSON.stringify(bad)).toBe(false);
      expect(result.error?.issues[0]?.message, JSON.stringify(bad)).toBe("от одной до восьми сумм через запятую, например 50, 100, 250");
    }
  });

  it("ссылки Tribute: только https или пусто, для Telegram и веба отдельно", () => {
    for (const setting of [SETTINGS.donateTributeUrlTelegram, SETTINGS.donateTributeUrlWeb]) {
      expect(setting.schema.safeParse("http://t.me/tribute/app").success, setting.key).toBe(false);
      expect(setting.schema.safeParse("t.me/tribute").success, setting.key).toBe(false);
      expect(setting.schema.safeParse("https://t.me/tribute/app?startapp=donate").success, setting.key).toBe(true);
      expect(setting.schema.safeParse("").success, setting.key).toBe(true);
    }
  });
});

describe("вид доната для игрока", () => {
  const TELEGRAM_LINK = "https://t.me/tribute/app?startapp=donate";
  const WEB_LINK = "https://tribute.tg/donate/rubezh";
  const links = { "donate.tribute-url-telegram": TELEGRAM_LINK, "donate.tribute-url-web": WEB_LINK };

  it("Telegram при включённой оплате: пределы способа, готовые суммы из настройки, режим и ссылка Telegram", async () => {
    const ctx = setup({ panel: { ...links, "donate.amounts": "250, 50, 100" } });
    const view = await ctx.donations.view(player(), new Date(NOW));
    expect(view).toEqual({
      stars: { min: 1, max: 10_000, presets: [50, 100, 250], mode: "live" },
      tribute: { url: TELEGRAM_LINK, way: "tribute_telegram" },
      supporter: false,
    });
  });

  it("готовые суммы по умолчанию — из каталога, лишние за пределом способа не показываются", async () => {
    expect((await setup().donations.view(player(), new Date(NOW))).stars?.presets).toEqual([50, 100, 250, 500, 1000]);
    expect((await setup({ panel: { "donate.amounts": "5, 20000" } }).donations.view(player(), new Date(NOW))).stars?.presets).toEqual([5]);
  });

  it("тестовый режим оплаты виден в ответе", async () => {
    const ctx = setup({ env: config({ PAYMENTS_TEST_MODE: "true", NODE_ENV: "development" }) });
    expect((await ctx.donations.view(player(), new Date(NOW))).stars?.mode).toBe("test");
  });

  it("стоп-кран выключен — звёздной части нет, ссылка Tribute остаётся: оплата идёт вне игры", async () => {
    const ctx = setup({ env: config({ PAYMENTS_ENABLED: "false" }), panel: links });
    const view = await ctx.donations.view(player(), new Date(NOW));
    expect(view.stars).toBeNull();
    expect(view.tribute).toEqual({ url: TELEGRAM_LINK, way: "tribute_telegram" });
  });

  it("вход разработчика не платит звёздами: способ есть, а платить нечем", async () => {
    const view = await setup({ panel: links }).donations.view(player("telegram", "dev-1"), new Date(NOW));
    expect(view.stars).toBeNull();
    expect(view.tribute?.way).toBe("tribute_telegram");
  });

  it("веб: звёзд нет, ссылка веба; MAX и VK: нет ни того, ни другого", async () => {
    const ctx = setup({ panel: links });
    expect(await ctx.donations.view(player("web", "w-1"), new Date(NOW))).toEqual({ stars: null, tribute: { url: WEB_LINK, way: "tribute_web" }, supporter: false });
    for (const platform of ["max", "vk"] as const) {
      expect(await ctx.donations.view(player(platform, "12345"), new Date(NOW)), platform).toEqual({ stars: null, tribute: null, supporter: false });
    }
  });

  it("пустая ссылка — кнопки нет, у каждой площадки своя", async () => {
    const onlyWeb = setup({ panel: { "donate.tribute-url-web": WEB_LINK } });
    expect((await onlyWeb.donations.view(player(), new Date(NOW))).tribute).toBeNull();
    const onlyTelegram = setup({ panel: { "donate.tribute-url-telegram": TELEGRAM_LINK } });
    expect((await onlyTelegram.donations.view(player("web", "w-1"), new Date(NOW))).tribute).toBeNull();
  });

  it("покупки закрыты — звёздной части нет, ссылка Tribute остаётся; чужое и снятое ограничение не мешает", async () => {
    const ctx = setup({ panel: links });
    const me = player();
    ctx.restrictions.restrict(me.accountId, "purchases");
    const view = await ctx.donations.view(me, new Date(NOW));
    expect(view.stars).toBeNull();
    expect(view.tribute).not.toBeNull();

    ctx.restrictions.restrict(player().accountId, "purchases");
    ctx.restrictions.restrict(me.accountId, "promo_codes");
    const other = player();
    ctx.restrictions.restrict(other.accountId, "purchases", { endsAt: new Date(NOW - 1_000) });
    expect((await ctx.donations.view(other, new Date(NOW))).stars).not.toBeNull();
  });

  it("supporter отражает знак аккаунта", async () => {
    const ctx = setup();
    const me = player();
    expect((await ctx.donations.view(me, new Date(NOW))).supporter).toBe(false);
    await ctx.supporters.markSupporter(me.accountId, new Date(NOW));
    expect((await ctx.donations.view(me, new Date(NOW))).supporter).toBe(true);
    expect((await ctx.donations.view(player(), new Date(NOW))).supporter).toBe(false);
  });
});

describe("заказ доната", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it.each([0, -5, 1.5, Number.NaN, 10_001, 1e9])("сумма %s — «Некорректная сумма», счёта нет", async (amount) => {
    await expect(ctx.donations.order(player(), amount, new Date(NOW))).rejects.toThrow(new ValidationError("Некорректная сумма"));
    expect(ctx.purchases.rows.size).toBe(0);
    expect(ctx.api.sent).toEqual([]);
  });

  it.each([1, 10_000])("сумма %s — на границе пределов: счёт выставлен", async (amount) => {
    const invoice = await ctx.donations.order(player(), amount, new Date(NOW));
    expect(invoice).toMatchObject({ sku: "donation", status: "pending", priceStars: amount, chargedStars: amount, mode: "live" });
    expect(ctx.api.sent.at(-1)).toMatchObject({ payload: invoice.purchaseId, stars: amount, title: "Поддержка проекта" });
  });

  it("в оплату уходит донат, а не товар: вид, sku, цена — сумма, не разовый; название влезает в окно Telegram", async () => {
    const calls: unknown[] = [];
    const original = ctx.payments.shopInvoice.bind(ctx.payments);
    ctx.payments.shopInvoice = async (account, order, nowMs) => {
      calls.push(order);
      return await original(account, order, nowMs);
    };

    await ctx.donations.order(player(), 250, new Date(NOW));

    expect(calls).toEqual([
      {
        product: "donation",
        sku: "donation",
        priceStars: 250,
        once: false,
        text: { title: "Поддержка проекта", description: expect.stringContaining("Игровых наград за него нет") },
      },
    ]);
    const text = (calls[0] as { text: { title: string; description: string } }).text;
    expect(text.title.length).toBeLessThanOrEqual(32);
    expect(text.description).toContain("знак «Поддержал проект»");
    expect(ctx.purchases.rows.size).toBe(1);
    expect([...ctx.purchases.rows.values()][0]).toMatchObject({ product: "donation", sku: "donation", runId: null, priceStars: 250 });
  });

  it("донатить можно много раз: каждый счёт — новая покупка", async () => {
    const me = player();
    const first = await ctx.donations.order(me, 50, new Date(NOW));
    const second = await ctx.donations.order(me, 50, new Date(NOW));
    expect(second.purchaseId).not.toBe(first.purchaseId);
    expect(ctx.purchases.rows.size).toBe(2);
  });

  it("тестовая оплата: цена — сумма доната, спишется одна звезда, в окне оплаты помечено «тест»", async () => {
    const test = setup({ env: config({ PAYMENTS_TEST_MODE: "true", NODE_ENV: "development" }) });
    expect(await test.donations.order(player(), 500, new Date(NOW))).toMatchObject({ priceStars: 500, chargedStars: 1, mode: "test" });
    expect(test.api.sent.at(-1)?.title).toBe("Поддержка проекта — тест");
  });

  it("покупки закрыты — отказ ограничения раньше всего, ни покупки, ни счёта", async () => {
    const me = player();
    ctx.restrictions.restrict(me.accountId, "purchases");

    await expect(ctx.donations.order(me, 50, new Date(NOW))).rejects.toMatchObject({ code: "account_restricted" });
    // Даже негодная сумма и площадка без оплаты отвечают тем же: аккаунту незачем знать, что с заказом.
    await expect(ctx.donations.order(me, 0, new Date(NOW))).rejects.toMatchObject({ code: "account_restricted" });
    await expect(ctx.donations.order({ ...me, platform: "vk" }, 50, new Date(NOW))).rejects.toMatchObject({ code: "account_restricted" });
    expect(ctx.purchases.rows.size).toBe(0);
    expect(ctx.api.sent).toEqual([]);
  });

  it("площадка без способа оплаты — «оплата только в Telegram»", async () => {
    await expect(ctx.donations.order(player("web", "w-1"), 50, new Date(NOW))).rejects.toBeInstanceOf(PaymentsUnsupportedError);
    await expect(ctx.donations.order(player("vk", "12345"), 50, new Date(NOW))).rejects.toBeInstanceOf(PaymentsUnsupportedError);
  });

  it("вход разработчика платить звёздами не может", async () => {
    await expect(ctx.donations.order(player("telegram", "dev-1"), 50, new Date(NOW))).rejects.toBeInstanceOf(PaymentsUnsupportedError);
  });

  it("оплата выключена — отказ стоп-крана из оплаты доходит как есть", async () => {
    const off = setup({ env: config({ PAYMENTS_ENABLED: "false" }) });
    await expect(off.donations.order(player(), 50, new Date(NOW))).rejects.toBeInstanceOf(DisabledError);
    expect(off.purchases.rows.size).toBe(0);
  });
});

describe("выдача знака", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("подтверждённая оплата ставит знак на аккаунт, покупка помечена выданной; дата — время оплаты", async () => {
    const me = player();
    const row = await donated(ctx, me, 100);
    expect(await ctx.supporters.isSupporter(me.accountId)).toBe(true);
    expect(ctx.supporters.supporters.get(me.accountId)).toEqual(row.paidAt);
    expect(row.fulfilledAt).not.toBeNull();
  });

  it("донат — не покупка магазина: выдача зарегистрирована за видом donation", async () => {
    expect(ctx.fulfillment.products()).toEqual(["donation"]);
  });

  it("повторная выдача и вторая оплата дату первого доната не меняют", async () => {
    const me = player();
    const first = await donated(ctx, me, 100, "charge-1");
    const firstDate = ctx.supporters.supporters.get(me.accountId);
    await ctx.donations.fulfill(first);
    await ctx.donations.fulfill({ ...first, paidAt: new Date(NOW + 86_400_000) });
    await donated(ctx, me, 250, "charge-2");
    expect(ctx.supporters.supporters.get(me.accountId)).toEqual(firstDate);
  });

  it("оплата без paidAt (не бывает в проде) всё равно ставит знак текущим временем", async () => {
    const me = player();
    const row = await donated(ctx, me, 100);
    ctx.supporters.supporters.delete(me.accountId);
    await ctx.donations.fulfill({ ...row, paidAt: null });
    expect(ctx.supporters.supporters.get(me.accountId)).toBeInstanceOf(Date);
  });

  it("повтор подтверждения от площадки второй раз не выдаёт", async () => {
    const me = player();
    const row = await donated(ctx, me, 100, "charge-1");
    const date = ctx.supporters.supporters.get(me.accountId);
    await pay(ctx, row.purchaseId, me.platformUserId, "charge-1");
    expect(ctx.supporters.supporters.get(me.accountId)).toEqual(date);
  });

  it("тестовая оплата знак тоже ставит: звезда возвращается сразу, а знак остаётся (решение 19.10.2026)", async () => {
    const test = setup({ env: config({ PAYMENTS_TEST_MODE: "true", NODE_ENV: "development" }) });
    const me = player();
    await donated(test, me, 500, "charge-test");
    expect(await test.supporters.isSupporter(me.accountId)).toBe(true);
    expect(test.api.refunded).toContainEqual({ userId: Number(me.platformUserId), chargeId: "charge-test" });
  });

  it("чужой аккаунт знака не получает", async () => {
    await donated(ctx, player(), 100);
    expect(await ctx.supporters.isSupporter(player().accountId)).toBe(false);
  });
});

describe("снятие знака внешним возвратом", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("единственный донат возвращён по спору — знак снят, строка отзыва говорит об этом", async () => {
    const me = player();
    const row = await donated(ctx, me, 100, "charge-dispute");

    await ctx.confirmation.refunded("charge-dispute", NOW + 60_000);

    expect(await ctx.supporters.isSupporter(me.accountId)).toBe(false);
    expect(await ctx.revocation.revoke({ ...row, status: "refunded", refundReason: "external" }, new Date(NOW))).toEqual({ lines: ["знак «Поддержал проект» снят"] });
  });

  it("есть другой оплаченный и не возвращённый донат — знак остаётся, строка отзыва говорит почему", async () => {
    const me = player();
    const first = await donated(ctx, me, 100, "charge-1");
    await donated(ctx, me, 250, "charge-2");

    await ctx.confirmation.refunded("charge-1", NOW + 60_000);

    expect(await ctx.supporters.isSupporter(me.accountId)).toBe(true);
    expect(await ctx.donations.revoke(first, new Date(NOW))).toEqual({ lines: ["знак остаётся: есть другой донат"] });
  });

  it("оба доната возвращены — знак снят; порядок возвратов не важен", async () => {
    const me = player();
    await donated(ctx, me, 100, "charge-1");
    await donated(ctx, me, 250, "charge-2");

    await ctx.confirmation.refunded("charge-2", NOW + 60_000);
    expect(await ctx.supporters.isSupporter(me.accountId)).toBe(true);
    await ctx.confirmation.refunded("charge-1", NOW + 120_000);
    expect(await ctx.supporters.isSupporter(me.accountId)).toBe(false);
  });

  it("повтор обработки возврата безвреден: знак снят один раз, второй донат после возврата знак ставит заново", async () => {
    const me = player();
    await donated(ctx, me, 100, "charge-1");
    await ctx.confirmation.refunded("charge-1", NOW + 60_000);
    await ctx.confirmation.refunded("charge-1", NOW + 120_000);
    expect(await ctx.supporters.isSupporter(me.accountId)).toBe(false);

    await donated(ctx, me, 50, "charge-2");
    expect(await ctx.supporters.isSupporter(me.accountId)).toBe(true);
  });

  it("возврат чужого доната знак игрока не трогает", async () => {
    const me = player();
    await donated(ctx, me, 100, "charge-1");
    const stranger = player("telegram", "555000333");
    await donated(ctx, stranger, 100, "charge-2");

    await ctx.confirmation.refunded("charge-2", NOW + 60_000);

    expect(await ctx.supporters.isSupporter(me.accountId)).toBe(true);
    expect(await ctx.supporters.isSupporter(stranger.accountId)).toBe(false);
  });

  it("возврат по решению поддержки идёт тем же отзывом: единственный донат — знак снят, при втором — остаётся", async () => {
    const me = player();
    const only = await donated(ctx, me, 100, "charge-m1");
    for (const order of await ctx.refunds.manual(only.purchaseId, NOW + 60_000)) await ctx.refunds.refund(order, NOW + 120_000);
    expect(await ctx.supporters.isSupporter(me.accountId)).toBe(false);

    const again = player("telegram", "555000444");
    const first = await donated(ctx, again, 100, "charge-m2");
    await donated(ctx, again, 250, "charge-m3");
    for (const order of await ctx.refunds.manual(first.purchaseId, NOW + 60_000)) await ctx.refunds.refund(order, NOW + 120_000);
    expect(await ctx.supporters.isSupporter(again.accountId)).toBe(true);
  });

  it("тестовая оплата возвращается нами и знак не снимает", async () => {
    const test = setup({ env: config({ PAYMENTS_TEST_MODE: "true", NODE_ENV: "development" }) });
    const me = player();
    await donated(test, me, 500, "charge-test");

    await test.confirmation.refunded("charge-test", NOW + 60_000);

    expect(await test.supporters.isSupporter(me.accountId)).toBe(true);
  });

  it("реестр отзывов отдаёт донат донатам: повторная регистрация вида — ошибка", () => {
    expect(() => ctx.revocation.register("donation", async () => ({ lines: [] }))).toThrow(/уже зарегистрирован/);
  });
});
