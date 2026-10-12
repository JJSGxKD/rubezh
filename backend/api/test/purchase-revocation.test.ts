import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PurchaseRevocation, type Revocation } from "../src/modules/payments/purchase-revocation.js";
import type { PurchaseProduct, StoredPurchase } from "../src/modules/payments/purchase-types.js";

/**
 * Реестр отзыва оплаченного (tasks/T-0023): каждый владелец товара
 * регистрирует свой отзыв, как уже регистрирует выдачу. Модуль оплаты не знает
 * ни кошелька, ни VIP.
 */

const AT = new Date(Date.UTC(2026, 9, 6, 9, 5, 0));

function purchase(product: PurchaseProduct, patch: Partial<StoredPurchase> = {}): StoredPurchase {
  return {
    purchaseId: randomUUID(),
    accountId: randomUUID(),
    product,
    runId: null,
    continueNo: null,
    elapsedSec: null,
    sku: product === "continue_run" ? null : "starter",
    priceStars: 50,
    chargedStars: 50,
    mode: "live",
    status: "refunded",
    telegramChargeId: "charge-1",
    invoicedAt: AT,
    paidAt: AT,
    refundReason: "external",
    refundRequestedAt: null,
    refundedAt: AT,
    fulfilledAt: AT,
    renewalOf: null,
    ...patch,
  };
}

describe("отзыв оплаченного", () => {
  it("зарегистрированный отзыв вызывается с покупкой и моментом, его строки возвращаются как есть", async () => {
    const revocation = new PurchaseRevocation();
    const calls: { purchase: StoredPurchase; at: Date }[] = [];
    revocation.register("shop_item", async (bought, at) => {
      calls.push({ purchase: bought, at });
      return { lines: ["gems: 120 из 150"] };
    });
    const bought = purchase("shop_item");

    const result = await revocation.revoke(bought, AT);

    expect(result).toEqual({ lines: ["gems: 120 из 150"] });
    expect(calls).toEqual([{ purchase: bought, at: AT }]);
  });

  it("вида без отзыва — «ничего», и никто чужой не вызывается", async () => {
    const revocation = new PurchaseRevocation();
    let called = 0;
    revocation.register("vip", async () => {
      called += 1;
      return { lines: ["VIP"] };
    });

    const result = await revocation.revoke(purchase("continue_run"), AT);

    expect(result).toEqual({ lines: ["ничего — товар не забирается"] });
    expect(called).toBe(0);
  });

  it("отзывы разных видов независимы: покупка уходит тому, чей вид", async () => {
    const revocation = new PurchaseRevocation();
    revocation.register("shop_item", async () => ({ lines: ["магазин"] }));
    revocation.register("vip", async () => ({ lines: ["VIP"] }));

    expect(await revocation.revoke(purchase("vip"), AT)).toEqual({ lines: ["VIP"] });
    expect(await revocation.revoke(purchase("shop_item"), AT)).toEqual({ lines: ["магазин"] });
  });

  it("повторная регистрация того же вида — ошибка: два отзыва забрали бы дважды", () => {
    const revocation = new PurchaseRevocation();
    const revoker = async (): Promise<Revocation> => ({ lines: [] });
    revocation.register("vip", revoker);

    expect(() => revocation.register("vip", revoker)).toThrow("отзыв vip уже зарегистрирован");
  });

  it("ошибка отзыва не глотается: обработка возврата упадёт, и очередь её повторит", async () => {
    const revocation = new PurchaseRevocation();
    revocation.register("shop_item", async () => Promise.reject(new Error("кошелёк недоступен")));

    await expect(revocation.revoke(purchase("shop_item"), AT)).rejects.toThrow("кошелёк недоступен");
  });
});
