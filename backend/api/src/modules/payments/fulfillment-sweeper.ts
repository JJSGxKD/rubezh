import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../../infra/redis.js";
import { FULFILLMENT_SWEEP } from "./payments-limits.js";
import { PaymentsHooks } from "./payments-hooks.js";
import { PaymentRefunds } from "./payment-refunds.js";
import { PaymentsQueue } from "./payments-queue.js";
import { PurchaseFulfillment, UndeliverableError } from "./purchase-fulfillment.js";
import type { StoredPurchase } from "./purchase-types.js";
import { PURCHASES_REPOSITORY, type PurchasesRepository } from "./purchases.repository.js";

/**
 * Довыдача оплаченного (tasks/T-0003): каждая оплата заканчивается выдачей
 * или возвратом звёзд. Выдачу делает задание очереди оплаты, но после десяти
 * неудачных попыток оно бросается, и покупка осталась бы оплаченной и не
 * выданной навсегда. Проход подбирает такие покупки раз в пять минут:
 *
 * - выдача прошла — покупка отмечена выданной;
 * - товара больше нет в каталоге (`UndeliverableError`) — звёзды
 *   возвращаются цепочкой возвратов, а команда узнаёт об этом;
 * - любая другая ошибка (база, кошелёк, баг) — автоматического возврата нет:
 *   ошибка может быть временной, решает человек. Проход пробует снова на
 *   каждом тике, команда получает одно сообщение на покупку.
 *
 * Проход — под распределённым локом, как возврат бустов
 * (`boosts/boosts-refunder.ts`): при нескольких репликах работает одна, а
 * повтор безопасен и без лока — выдача идемпотентна ключом в журнале кошелька.
 * Модуль оплаты о Telegram не знает: команде сообщает слушатель события
 * `PaymentsHooks.onStuck`.
 */

const LOCK_KEY = "payments:fulfill:lock";

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

/** Итог прохода: сколько выдано, сколько возвращается и сколько осталось зависшими. */
export interface SweepResult {
  fulfilled: number;
  refunded: number;
  stuck: number;
}

@Injectable()
export class FulfillmentSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("payments");
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(PURCHASES_REPOSITORY) private readonly repository: Pick<PurchasesRepository, "undelivered" | "markFulfilled">,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "eval">,
    // Классы, а не `Pick<…>`: метаданные декоратора превращают `Pick` в `Object`, и Nest не знает, что подставить.
    private readonly fulfillment: PurchaseFulfillment,
    private readonly refunds: PaymentRefunds,
    private readonly queue: PaymentsQueue,
    private readonly hooks: PaymentsHooks,
  ) {}

  onApplicationBootstrap(): void {
    // Там же, где включена сама очередь оплаты: есть база и площадка, которая присылает подтверждения.
    if (!this.queue.enabled) return;
    this.timer = setInterval(() => void this.tick(), FULFILLMENT_SWEEP.tickMs);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** Один проход; `null` — не запускался: идёт предыдущий, лок у другой реплики, Redis или база недоступны. */
  async tick(now = new Date()): Promise<SweepResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const token = randomUUID();
      const claimed = await this.redis.set(LOCK_KEY, token, "PX", FULFILLMENT_SWEEP.lockTtlMs, "NX");
      if (claimed === null) return null;
      try {
        const rows = await this.repository.undelivered(
          this.fulfillment.products(),
          new Date(now.getTime() - FULFILLMENT_SWEEP.olderThanMs),
          FULFILLMENT_SWEEP.batch,
        );
        const result: SweepResult = { fulfilled: 0, refunded: 0, stuck: 0 };
        // По одной и каждая в своём try: сбой одной покупки не останавливает остальные.
        for (const purchase of rows) {
          const outcome = await this.handle(purchase, now);
          if (outcome !== "skipped") result[outcome] += 1;
        }
        return result;
      } finally {
        await this.redis.eval(RELEASE_SCRIPT, 1, LOCK_KEY, token);
      }
    } catch (error: unknown) {
      this.log("warn", "fulfillment_pass_failed", { reason: reasonOf(error) });
      return null;
    } finally {
      this.running = false;
    }
  }

  private async handle(purchase: StoredPurchase, now: Date): Promise<keyof SweepResult | "skipped"> {
    const fields = { purchaseId: purchase.purchaseId, accountId: purchase.accountId, product: purchase.product, sku: purchase.sku };
    try {
      // `false` — у товара выдачи сверх оплаты нет: подбирать нечего.
      if (!(await this.fulfillment.fulfill(purchase))) return "skipped";
      await this.repository.markFulfilled(purchase.purchaseId, now);
      this.log("log", "purchase_fulfilled_late", fields);
      return "fulfilled";
    } catch (error: unknown) {
      const reason = error instanceof UndeliverableError ? "undeliverable" : reasonOf(error);
      if (error instanceof UndeliverableError) {
        // Заказ возврата пишется в базу и сразу уходит в очередь: звёзды не ждут следующего перезапуска.
        await this.queue.dispatchRefunds(this.refunds.undeliverable(purchase.purchaseId, now.getTime()));
        this.log("warn", "purchase_undeliverable", { ...fields, detail: error.message });
      } else {
        this.log("error", "purchase_still_undelivered", { ...fields, reason });
      }
      await this.hooks.emitStuck({
        purchaseId: purchase.purchaseId,
        accountId: purchase.accountId,
        product: purchase.product,
        sku: purchase.sku,
        chargedStars: purchase.chargedStars,
        // Подобраны только оплаченные: пусто у строки, которой в выборке быть не должно.
        paidAt: purchase.paidAt ?? now,
        reason,
      });
      return error instanceof UndeliverableError ? "refunded" : "stuck";
    }
  }

  private log(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "payments", event, ...fields }));
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
