import { describe, expect, it } from "vitest";
import { FULFILLMENT_SWEEP } from "../src/modules/payments/payments-limits.js";
import { FulfillmentSweeper } from "../src/modules/payments/fulfillment-sweeper.js";
import type { StuckPurchase } from "../src/modules/payments/payments-hooks.js";
import { UndeliverableError } from "../src/modules/payments/purchase-fulfillment.js";
import type { PurchaseProduct, StoredPurchase } from "../src/modules/payments/purchase-types.js";
import type { RefundOrder } from "../src/modules/payments/purchases.repository.js";

/**
 * Довыдача оплаченного (tasks/T-0003): проход подбирает покупки, у которых
 * выдача так и не прошла, и либо выдаёт их, либо возвращает звёзды, либо
 * зовёт человека. Репозиторий, выдача, возвраты, очередь и Redis — подставные.
 */

const NOW = new Date("2026-10-06T12:00:00Z");

function purchase(id: string, patch: Partial<StoredPurchase> = {}): StoredPurchase {
  return {
    purchaseId: id,
    accountId: `account-${id}`,
    product: "shop_item",
    runId: null,
    continueNo: null,
    elapsedSec: null,
    sku: "starter_pack",
    priceStars: 50,
    chargedStars: 50,
    mode: "live",
    status: "paid",
    telegramChargeId: `charge-${id}`,
    invoicedAt: new Date("2026-10-06T09:00:00Z"),
    paidAt: new Date("2026-10-06T09:30:00Z"),
    refundReason: null,
    refundRequestedAt: null,
    refundedAt: null,
    fulfilledAt: null,
    renewalOf: null,
    ...patch,
  };
}

/** Redis на двух командах: `SET … NX` и снятие лока своим токеном. */
class FakeRedis {
  readonly values = new Map<string, string>();

  async set(key: string, value: string, ..._args: unknown[]): Promise<"OK" | null> {
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

function setup(rows: StoredPurchase[], behaviour: (purchase: StoredPurchase) => Promise<boolean> | boolean = () => true, markFails: readonly string[] = []) {
  const redis = new FakeRedis();
  const calls = { undelivered: [] as { products: readonly PurchaseProduct[]; paidBefore: Date; limit: number }[], fulfilled: [] as string[], marked: [] as string[], undeliverable: [] as string[] };
  const dispatched: RefundOrder[] = [];
  const stuck: StuckPurchase[] = [];

  const sweeper = new FulfillmentSweeper(
    {
      undelivered: async (products, paidBefore, limit) => {
        calls.undelivered.push({ products, paidBefore, limit });
        return rows;
      },
      markFulfilled: async (purchaseId) => {
        if (markFails.includes(purchaseId)) throw new Error("база недоступна");
        calls.marked.push(purchaseId);
      },
    },
    redis as never,
    {
      products: () => ["shop_item", "vip"],
      fulfill: async (row: StoredPurchase) => {
        calls.fulfilled.push(row.purchaseId);
        return await behaviour(row);
      },
    } as never,
    {
      undeliverable: async (purchaseId: string) => {
        calls.undeliverable.push(purchaseId);
        return [{ purchaseId, platform: "telegram", chargeId: `charge-${purchaseId}`, payerId: "777", reason: "undeliverable" }];
      },
    } as never,
    {
      enabled: true,
      dispatchRefunds: async (orders: Promise<RefundOrder[]>) => void dispatched.push(...(await orders)),
    } as never,
    { emitStuck: async (event: StuckPurchase) => void stuck.push(event) } as never,
  );
  return { sweeper, redis, calls, dispatched, stuck };
}

describe("довыдача оплаченных покупок", () => {
  it("выдача прошла — покупка отмечена выданной, людей не зовут", async () => {
    const { sweeper, calls, stuck, dispatched } = setup([purchase("a")]);

    expect(await sweeper.tick(NOW)).toEqual({ fulfilled: 1, refunded: 0, stuck: 0 });

    expect(calls.marked).toEqual(["a"]);
    expect(stuck).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it("товара больше нет — заказан возврат undeliverable и передан в очередь, человека зовут с причиной", async () => {
    const { sweeper, calls, stuck, dispatched } = setup([purchase("a")], () => {
      throw new UndeliverableError("товара starter_pack нет в каталоге — выдавать нечего");
    });

    expect(await sweeper.tick(NOW)).toEqual({ fulfilled: 0, refunded: 1, stuck: 0 });

    expect(calls.undeliverable).toEqual(["a"]);
    expect(dispatched).toEqual([expect.objectContaining({ purchaseId: "a", reason: "undeliverable" })]);
    expect(stuck).toEqual([
      {
        purchaseId: "a",
        accountId: "account-a",
        product: "shop_item",
        sku: "starter_pack",
        chargedStars: 50,
        paidAt: new Date("2026-10-06T09:30:00Z"),
        reason: "undeliverable",
      },
    ]);
    expect(calls.marked).toEqual([]);
  });

  it("выдача упала по другой причине — ни выдачи, ни возврата; человека зовут с текстом ошибки", async () => {
    const { sweeper, calls, stuck, dispatched } = setup([purchase("a")], () => {
      throw new Error("connection refused");
    });

    expect(await sweeper.tick(NOW)).toEqual({ fulfilled: 0, refunded: 0, stuck: 1 });

    expect(calls.marked).toEqual([]);
    expect(calls.undeliverable).toEqual([]);
    expect(dispatched).toEqual([]);
    expect(stuck).toEqual([expect.objectContaining({ purchaseId: "a", reason: "connection refused" })]);
  });

  it("у товара без выдачи (fulfill вернул false) покупка не отмечается выданной и не зовёт человека", async () => {
    const { sweeper, calls, stuck } = setup([purchase("a")], () => false);

    expect(await sweeper.tick(NOW)).toEqual({ fulfilled: 0, refunded: 0, stuck: 0 });

    expect(calls.marked).toEqual([]);
    expect(stuck).toEqual([]);
  });

  it("сбой одной покупки не останавливает проход: вторая обрабатывается", async () => {
    const { sweeper, calls } = setup([purchase("a"), purchase("b")], (row) => {
      if (row.purchaseId === "a") throw new Error("база недоступна");
      return true;
    });

    expect(await sweeper.tick(NOW)).toEqual({ fulfilled: 1, refunded: 0, stuck: 1 });

    expect(calls.fulfilled).toEqual(["a", "b"]);
    expect(calls.marked).toEqual(["b"]);
  });

  it("сбой записи отметки о выдаче — покупка считается зависшей, остальные идут дальше", async () => {
    const { sweeper, calls, stuck } = setup([purchase("a"), purchase("b")], () => true, ["a"]);

    expect(await sweeper.tick(NOW)).toEqual({ fulfilled: 1, refunded: 0, stuck: 1 });

    expect(calls.marked).toEqual(["b"]);
    expect(stuck).toEqual([expect.objectContaining({ purchaseId: "a", reason: "база недоступна" })]);
  });

  it("лок занят — проход не запускается, репозиторий не зовётся", async () => {
    const { sweeper, redis, calls } = setup([purchase("a")]);
    redis.values.set("payments:fulfill:lock", "other-replica");

    expect(await sweeper.tick(NOW)).toBeNull();

    expect(calls.undelivered).toEqual([]);
    expect(redis.values.get("payments:fulfill:lock")).toBe("other-replica");
  });

  it("лок снимается после прохода, следующий проход возможен", async () => {
    const { sweeper, redis } = setup([]);

    expect(await sweeper.tick(NOW)).toEqual({ fulfilled: 0, refunded: 0, stuck: 0 });
    expect(redis.values.has("payments:fulfill:lock")).toBe(false);
    expect(await sweeper.tick(NOW)).toEqual({ fulfilled: 0, refunded: 0, stuck: 0 });
  });

  it("срок отбора — сейчас минус 45 минут, в отбор уходят товары с выдачей и размер пачки", async () => {
    const { sweeper, calls } = setup([]);

    await sweeper.tick(NOW);

    expect(FULFILLMENT_SWEEP.olderThanMs).toBe(45 * 60_000);
    expect(calls.undelivered).toEqual([
      { products: ["shop_item", "vip"], paidBefore: new Date(NOW.getTime() - 45 * 60_000), limit: FULFILLMENT_SWEEP.batch },
    ]);
  });

  it("база упала на отборе — проход возвращает null и не бросает", async () => {
    const redis = new FakeRedis();
    const sweeper = new FulfillmentSweeper(
      {
        undelivered: async () => {
          throw new Error("connection refused");
        },
        markFulfilled: async () => undefined,
      },
      redis as never,
      { products: () => ["shop_item"], fulfill: async () => true } as never,
      { undeliverable: async () => [] } as never,
      { enabled: true, dispatchRefunds: async () => undefined } as never,
      { emitStuck: async () => undefined } as never,
    );

    expect(await sweeper.tick(NOW)).toBeNull();
    expect(redis.values.has("payments:fulfill:lock")).toBe(false);
  });
});
