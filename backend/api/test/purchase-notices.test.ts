import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentRefunds } from "../src/modules/payments/payment-refunds.js";
import { PaymentsHooks, type RefundDone, type SupportAction } from "../src/modules/payments/payments-hooks.js";
import { PurchaseNotices } from "../src/modules/payments/purchase-notices.js";
import { PurchaseRevocation } from "../src/modules/payments/purchase-revocation.js";
import type { PurchaseAction, RefundReason, StoredPurchase } from "../src/modules/payments/purchase-types.js";
import { TelegramApiError } from "../src/platforms/telegram/telegram-bot-api.js";
import { FakeStarsApi, starsProviders } from "./helpers/fake-stars-api.js";
import { MemoryPurchasesRepository } from "./helpers/memory-purchases.js";
import { memoryNotifications } from "./helpers/memory-notifications.js";

/**
 * Сообщение игроку о компенсации и возврате звёзд (docs/35-stage4-plan.md Р209,
 * WP53, tasks/T-0436). Слушатель событий оплаты пишет вид `purchase_support` в
 * ленту; дубль в бота делает уже готовый механизм ленты. Закрепляется то, где
 * такое сообщение ломается: лишнее (автоматические возвраты, выдача, повтор),
 * потерянное (возврат поддержкой и из-за снятого товара) и сбой ленты, который
 * не должен отменить уже выполненные деньги.
 */

const NOW = new Date(Date.UTC(2026, 10, 12, 9));
/** Оплата в 22:30 UTC 10.11 — это уже 11.11 по Москве */
const PAID_AT = new Date(Date.UTC(2026, 10, 10, 22, 30));
const OWNER_TELEGRAM_ID = "555000111";

function purchase(accountId: string, patch: Partial<StoredPurchase> = {}): StoredPurchase {
  return {
    purchaseId: randomUUID(),
    accountId,
    product: "shop_item",
    runId: null,
    continueNo: null,
    elapsedSec: null,
    sku: "starter_pack",
    priceStars: 50,
    chargedStars: 50,
    mode: "live",
    status: "paid",
    telegramChargeId: `charge-${randomUUID()}`,
    invoicedAt: new Date(PAID_AT.getTime() - 60_000),
    paidAt: PAID_AT,
    refundReason: null,
    refundRequestedAt: null,
    refundedAt: null,
    fulfilledAt: PAID_AT,
    renewalOf: null,
    ...patch,
  };
}

function setup() {
  const accountId = randomUUID();
  const feed = memoryNotifications();
  const deliver = vi.spyOn(feed.service, "deliver");
  const hooks = new PaymentsHooks();
  const notices = new PurchaseNotices(hooks, feed.service);
  notices.onModuleInit();

  const purchases = new MemoryPurchasesRepository();
  purchases.owners.set(accountId, OWNER_TELEGRAM_ID);
  const api = new FakeStarsApi();
  const revoked: string[] = [];
  const revocation = new PurchaseRevocation();
  revocation.register("shop_item", async (bought) => {
    revoked.push(bought.purchaseId);
    return { lines: ["самоцветы: 120 из 150"] };
  });
  const refunds = new PaymentRefunds(purchases, starsProviders(api), revocation, hooks);
  const done: RefundDone[] = [];
  hooks.onRefundDone("тест", async (event) => {
    done.push(event);
  });

  return { accountId, feed, deliver, hooks, notices, purchases, api, revoked, refunds, done };
}

type Setup = ReturnType<typeof setup>;

function supportAction(kind: PurchaseAction, bought: StoredPurchase, extra: Partial<SupportAction> = {}): SupportAction {
  return { kind, purchase: bought, actorName: "Дым", note: "Сбой оплаты", at: NOW, ...extra };
}

/** Заказанный возврат — как его поднимает очередь: из хранилища. */
async function ordered(s: Setup, reason: RefundReason, patch: Partial<StoredPurchase> = {}) {
  const bought = purchase(s.accountId, { refundReason: reason, refundRequestedAt: NOW, ...patch });
  s.purchases.rows.set(bought.purchaseId, bought);
  const [order] = await s.refunds.pending(10);
  if (order === undefined) throw new Error("возврат не заказан");
  return { bought, order };
}

describe("компенсация за сбой оплаты", () => {
  let s: Setup;

  beforeEach(() => {
    s = setup();
  });

  it("компенсация 120 самоцветов за 50 ⭐ от 11.11: вид purchase_support, действие compensated, ключ по покупке", async () => {
    const bought = purchase(s.accountId);

    await s.hooks.emitSupport(supportAction("compensate", bought, { gems: 120 }));

    expect(s.deliver).toHaveBeenCalledTimes(1);
    expect(s.deliver).toHaveBeenCalledWith({
      accountId: s.accountId,
      kind: "purchase_support",
      payload: { action: "compensated", stars: 50, gems: 120, paidAt: PAID_AT.toISOString(), reason: null, revoked: false },
      dedupeKey: `purchase_support:compensated:${bought.purchaseId}`,
      at: NOW,
    });
    expect(s.feed.repository.of(s.accountId)).toEqual([
      { kind: "purchase_support", payload: { action: "compensated", stars: 50, gems: 120, paidAt: PAID_AT.toISOString(), reason: null, revoked: false } },
    ]);
  });

  it("суммой звёзд берётся списанное с игрока, а не цена по прайсу", async () => {
    const bought = purchase(s.accountId, { priceStars: 100, chargedStars: 70 });

    await s.hooks.emitSupport(supportAction("compensate", bought, { gems: 10 }));

    expect(s.feed.repository.of(s.accountId)[0]?.payload).toMatchObject({ stars: 70, gems: 10 });
  });

  it("повтор события ленту не удваивает: строка одна, ключ тот же", async () => {
    const bought = purchase(s.accountId);

    await s.hooks.emitSupport(supportAction("compensate", bought, { gems: 120 }));
    await s.hooks.emitSupport(supportAction("compensate", bought, { gems: 120 }));

    expect(s.deliver).toHaveBeenCalledTimes(2);
    expect(s.feed.repository.rows).toHaveLength(1);
  });

  it("виды refund, fulfill и retry — не компенсация: сообщения нет", async () => {
    const bought = purchase(s.accountId);

    await s.hooks.emitSupport(supportAction("refund", bought));
    await s.hooks.emitSupport(supportAction("fulfill", bought));
    await s.hooks.emitSupport(supportAction("retry", bought));
    // даже с самоцветами в данных: поле у других видов не бывает, но слушатель смотрит на вид
    await s.hooks.emitSupport(supportAction("refund", bought, { gems: 120 }));

    expect(s.deliver).not.toHaveBeenCalled();
  });

  it("компенсация без самоцветов, с нулём или по неоплаченной покупке — писать нечего", async () => {
    await s.hooks.emitSupport(supportAction("compensate", purchase(s.accountId)));
    await s.hooks.emitSupport(supportAction("compensate", purchase(s.accountId), { gems: 0 }));
    await s.hooks.emitSupport(supportAction("compensate", purchase(s.accountId, { paidAt: null, status: "pending" }), { gems: 120 }));

    expect(s.deliver).not.toHaveBeenCalled();
  });
});

describe("возврат звёзд по нашему заказу", () => {
  let s: Setup;

  beforeEach(() => {
    s = setup();
  });

  it("поддержка вернула звёзды и забрала остаток: refunded, reason manual, revoked true, ключ по покупке", async () => {
    const { bought, order } = await ordered(s, "manual");

    await s.refunds.refund(order, NOW.getTime());

    expect(s.revoked).toEqual([bought.purchaseId]);
    expect(s.done).toEqual([{ purchase: expect.objectContaining({ purchaseId: bought.purchaseId, refundReason: "manual" }), revoked: true, at: NOW }]);
    expect(s.deliver).toHaveBeenCalledTimes(1);
    expect(s.deliver).toHaveBeenCalledWith({
      accountId: s.accountId,
      kind: "purchase_support",
      payload: { action: "refunded", stars: 50, gems: 0, paidAt: PAID_AT.toISOString(), reason: "manual", revoked: true },
      dedupeKey: `purchase_support:refunded:${bought.purchaseId}`,
      at: NOW,
    });
  });

  it("отзыв ничего не забрал (остатка нет): revoked false", async () => {
    const { order } = await ordered(s, "manual");
    const empty = new PurchaseRevocation();
    empty.register("shop_item", async () => ({ lines: [] }));
    const refunds = new PaymentRefunds(s.purchases, starsProviders(s.api), empty, s.hooks);

    await refunds.refund(order, NOW.getTime());

    expect(s.done[0]?.revoked).toBe(false);
    expect(s.feed.repository.of(s.accountId)[0]?.payload).toMatchObject({ action: "refunded", reason: "manual", revoked: false });
  });

  it("товара нет в каталоге (undeliverable): refunded, reason undeliverable, остаток не забирается", async () => {
    const { bought, order } = await ordered(s, "undeliverable");

    await s.refunds.refund(order, NOW.getTime());

    expect(s.revoked).toEqual([]);
    expect(s.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { action: "refunded", stars: 50, gems: 0, paidAt: PAID_AT.toISOString(), reason: "undeliverable", revoked: false },
        dedupeKey: `purchase_support:refunded:${bought.purchaseId}`,
      }),
    );
  });

  it("повтор того же задания (Telegram отвечает «уже возвращено») — второго сообщения нет", async () => {
    const { order } = await ordered(s, "manual");
    await s.refunds.refund(order, NOW.getTime());
    s.api.refundFailWith = new TelegramApiError("refundStarPayment", 400, "Bad Request: CHARGE_ALREADY_REFUNDED", null);

    await s.refunds.refund(order, NOW.getTime() + 60_000);

    expect(s.done).toHaveLength(1);
    expect(s.deliver).toHaveBeenCalledTimes(1);
    expect(s.feed.repository.rows).toHaveLength(1);
  });

  it("возврат неиспользованного второго шанса и тестовой оплаты — без сообщения", async () => {
    const unused = await ordered(s, "unused");
    await s.refunds.refund(unused.order, NOW.getTime());
    const test = await ordered(s, "test_mode", { mode: "test" });
    await s.refunds.refund(test.order, NOW.getTime());

    expect(s.done).toEqual([]);
    expect(s.deliver).not.toHaveBeenCalled();
  });

  it("возврат без покупки (лишняя или чужая оплата, сверка без строки) — без сообщения", async () => {
    // Строки покупки нет, возвращается сама оплата: писать некому и не о чем.
    await s.refunds.refund({ purchaseId: null, platform: "telegram", chargeId: "charge-orphan", payerId: OWNER_TELEGRAM_ID, reason: "unmatched" }, NOW.getTime());
    await s.refunds.refund({ purchaseId: null, platform: "telegram", chargeId: "charge-twice", payerId: OWNER_TELEGRAM_ID, reason: "duplicate" }, NOW.getTime());

    expect(s.done).toEqual([]);
    expect(s.deliver).not.toHaveBeenCalled();
  });

  it("площадка отказала окончательно — звёзды не вернулись, сообщения нет", async () => {
    const { order } = await ordered(s, "manual");
    s.api.refundFailWith = new TelegramApiError("refundStarPayment", 400, "Bad Request: PAYMENT_NOT_FOUND", null);

    await expect(s.refunds.refund(order, NOW.getTime())).rejects.toThrow();

    expect(s.deliver).not.toHaveBeenCalled();
  });

  it("отзыв остатка бросил — возврат записан, но сообщения ещё нет: оно уходит после отзыва", async () => {
    const { order } = await ordered(s, "manual");
    const failing = new PurchaseRevocation();
    failing.register("shop_item", async () => {
      throw new Error("кошелёк недоступен");
    });
    const refunds = new PaymentRefunds(s.purchases, starsProviders(s.api), failing, s.hooks);

    await expect(refunds.refund(order, NOW.getTime())).rejects.toThrow("кошелёк недоступен");

    expect(s.deliver).not.toHaveBeenCalled();
  });

  it("без подписчиков и без хуков в конструкторе возврат проходит, как раньше", async () => {
    const { order } = await ordered(s, "manual");
    const bare = new PaymentRefunds(s.purchases, starsProviders(s.api), new PurchaseRevocation());

    await expect(bare.refund(order, NOW.getTime())).resolves.toBeUndefined();
  });
});

describe("сбой записи уведомления не ломает деньги", () => {
  let warned: Record<string, unknown>[];
  let errored: Record<string, unknown>[];

  beforeEach(() => {
    warned = [];
    errored = [];
    vi.spyOn(Logger.prototype, "warn").mockImplementation((line: unknown) => {
      warned.push(JSON.parse(String(line)) as Record<string, unknown>);
    });
    vi.spyOn(Logger.prototype, "error").mockImplementation((line: unknown) => {
      errored.push(JSON.parse(String(line)) as Record<string, unknown>);
    });
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("лента не приняла компенсацию — строка warn purchase_notice_failed, исключения нет, слушатель сам не упал", async () => {
    const s = setup();
    s.deliver.mockRejectedValue(new Error("база недоступна"));
    const bought = purchase(s.accountId);

    await expect(s.hooks.emitSupport(supportAction("compensate", bought, { gems: 120 }))).resolves.toBeUndefined();

    expect(warned).toEqual([{ module: "payments", event: "purchase_notice_failed", purchaseId: bought.purchaseId, action: "compensated", reason: "база недоступна" }]);
    expect(errored.filter((line) => line.event === "listener_failed")).toEqual([]);
  });

  it("лента не приняла возврат — задание возврата проходит до конца, в логе purchase_notice_failed", async () => {
    const s = setup();
    s.deliver.mockRejectedValue(new Error("лента не отвечает"));
    const { bought, order } = await ordered(s, "manual");

    await expect(s.refunds.refund(order, NOW.getTime())).resolves.toBeUndefined();

    expect(s.purchases.rows.get(bought.purchaseId)).toMatchObject({ status: "refunded", refundedAt: NOW });
    expect(warned).toEqual([{ module: "payments", event: "purchase_notice_failed", purchaseId: bought.purchaseId, action: "refunded", reason: "лента не отвечает" }]);
    expect(errored.filter((line) => line.event === "listener_failed")).toEqual([]);
  });

  it("ошибка не Error — причина «unknown»", async () => {
    const s = setup();
    s.deliver.mockRejectedValue("строка вместо ошибки");

    await s.hooks.emitSupport(supportAction("compensate", purchase(s.accountId), { gems: 5 }));

    expect(warned[0]).toMatchObject({ event: "purchase_notice_failed", reason: "unknown" });
  });
});
