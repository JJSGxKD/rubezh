import { Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { FeedMark, TimelineEntry } from "./payment-timeline.js";
import type { PurchaseAction, StoredPurchase } from "./purchase-types.js";

/**
 * Источники хронологии платежа (Р209, WP53, tasks/T-0429). Лента сама знает
 * только покупку и журнал действий команды; всё остальное — брошенные задания,
 * сверка с площадкой, компенсация, предварительная проверка оплаты — приносят
 * соседние модули и задачи: каждый регистрирует здесь свой источник и дальше
 * дописывает в карточку строки, пометки ленты и действия, не трогая ленту.
 * Тот же приём, что `PaymentsHooks` и `PurchaseFulfillment`.
 *
 * **Сбой источника не ломает карточку.** Каждый вызов — с потолком в три
 * секунды и в `try`: упавший или зависший источник даёт пустой вклад и строку
 * `feed_source_failed` в логе, а остальные отвечают как обычно. Источники
 * опрашиваются параллельно, поэтому карточка ждёт самый медленный, а не
 * сумму.
 */

const SOURCE_TIMEOUT_MS = 3_000;

export interface PaymentFeedSource {
  /** строки хронологии по покупке */
  timeline(purchase: StoredPurchase): Promise<TimelineEntry[]>;
  /** пометки строк ленты — одним вызовом на страницу */
  marks(purchaseIds: readonly string[]): Promise<ReadonlyMap<string, readonly FeedMark[]>>;
  /** что источник открывает по покупке сейчас (`retry`, `compensate`); право проверяет сервис */
  actions(purchase: StoredPurchase): Promise<PurchaseAction[]>;
}

@Injectable()
export class PaymentFeedSources {
  private readonly logger = new Logger("payments");
  private readonly sources = new Map<string, PaymentFeedSource>();

  /** Повтор имени — замена, а не второй источник: перерегистрация не удваивает строки. */
  register(name: string, source: PaymentFeedSource): void {
    this.sources.set(name, source);
  }

  async timeline(purchase: StoredPurchase): Promise<TimelineEntry[]> {
    const parts = await this.ask((source) => source.timeline(purchase));
    return parts.flat();
  }

  /** Пометки без повторов: источник может отметить покупку тем же знаком, что и другой. */
  async marks(purchaseIds: readonly string[]): Promise<Map<string, FeedMark[]>> {
    const merged = new Map<string, FeedMark[]>();
    for (const part of await this.ask((source) => source.marks(purchaseIds))) {
      for (const [purchaseId, marks] of part) {
        const known = merged.get(purchaseId) ?? [];
        for (const mark of marks) if (!known.includes(mark)) known.push(mark);
        merged.set(purchaseId, known);
      }
    }
    return merged;
  }

  async actions(purchase: StoredPurchase): Promise<PurchaseAction[]> {
    const actions: PurchaseAction[] = [];
    for (const part of await this.ask((source) => source.actions(purchase))) {
      for (const action of part) if (!actions.includes(action)) actions.push(action);
    }
    return actions;
  }

  /** Ответы тех источников, что ответили, в порядке регистрации. */
  private async ask<T>(call: (source: PaymentFeedSource) => Promise<T>): Promise<T[]> {
    const answers = await Promise.all(
      [...this.sources].map(async ([name, source]): Promise<{ value: T } | null> => {
        try {
          return { value: await withTimeout(call(source), SOURCE_TIMEOUT_MS, `источник ленты ${name}`) };
        } catch (error: unknown) {
          this.logger.warn(JSON.stringify({ module: "payments", event: "feed_source_failed", source: name, reason: error instanceof Error ? error.message : "unknown" }));
          return null;
        }
      }),
    );
    return answers.flatMap((answer) => (answer === null ? [] : [answer.value]));
  }
}
