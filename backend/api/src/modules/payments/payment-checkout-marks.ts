import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { CheckoutRefusal } from "./checkout-answer.js";
import { PaymentFeedSources } from "./payment-feed-sources.js";
import type { TimelineEntry } from "./payment-timeline.js";
import type { StoredPurchase } from "./purchase-types.js";

/**
 * Последняя предварительная проверка оплаты по счёту покупки (Р209, WP53,
 * tasks/T-0430): когда площадка спрашивала и что ей ответили. Без этого «не
 * смог оплатить» в базе — только счёт: ответ жил лишь в логе сервера.
 *
 * Хранится **последняя** проверка, а не журнал: повторных проверок у одной
 * покупки единицы, и таблица ради них не нужна. Продление подписки площадка
 * проверяет по счёту первой покупки, поэтому оно перезаписывает её отметку —
 * это «последняя проверка по этому счёту».
 *
 * Отметку пишет `PaymentConfirmation` уже после ответа площадке и не ждёт её
 * (`payment-confirmation.ts`); здесь — запись, чтение и строка хронологии
 * карточки платежа, подключённая как источник ленты.
 */

/** Подписи отказов для карточки; ключи — весь `CheckoutRefusal`, поэтому новый отказ без подписи не соберётся. */
const REFUSAL_LABELS: Readonly<Record<CheckoutRefusal, string>> = {
  disabled: "оплата выключена",
  unknown_invoice: "счёт не найден",
  foreign_user: "платит другой игрок",
  purchases_closed: "покупки аккаунту закрыты",
  already_paid: "уже оплачено",
  subscription_active: "VIP уже действует",
  price_mismatch: "сумма не совпала",
  stale_invoice: "счёт устарел",
  run_finished: "забег закончен",
  continue_taken: "продолжено за рекламу",
  unavailable: "база не ответила",
};

/** Незнакомый код — отказ, который добавили позже подписи или стёрли из кода: он показывается сам, а не прячет проверку. */
const LABELS: ReadonlyMap<string, string> = new Map(Object.entries(REFUSAL_LABELS));

const PASSED_TEXT = "Предварительная проверка пройдена";

/** Две колонки отметки, как их отдаёт база. */
const markRowSchema = z.object({ checkoutAt: z.date().nullable(), checkoutRefusal: z.string().nullable() });

/** Последняя проверка покупки. `refusal` — строка, а не `CheckoutRefusal`: в базе мог остаться код, которого код уже не знает. */
export interface CheckoutMark {
  at: Date;
  /** `null` — проверка пройдена */
  refusal: string | null;
}

@Injectable()
export class PaymentCheckoutMarks implements OnModuleInit {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly sources: PaymentFeedSources,
  ) {}

  onModuleInit(): void {
    this.sources.register("checkout", {
      timeline: async (purchase) => this.timeline(purchase),
      // Пометок ленты и действий у проверки нет: она только объясняет, что случилось.
      marks: async () => new Map(),
      actions: async () => [],
    });
  }

  /**
   * Записать последнюю проверку. Покупки нет — ничего, не ошибка: проверка
   * могла прийти по чужому или стёртому счёту. Запись старой проверки,
   * опоздавшая за более свежей (две проверки одного счёта подряд, ответы
   * разошлись), её не перетирает.
   */
  async mark(purchaseId: string, at: Date, refusal: CheckoutRefusal | null): Promise<void> {
    await this.prisma.purchase.updateMany({
      where: { purchaseId, OR: [{ checkoutAt: null }, { checkoutAt: { lte: at } }] },
      data: { checkoutAt: at, checkoutRefusal: refusal },
    });
  }

  /** Последняя проверка; `null` — проверки не было или покупки нет. */
  async of(purchaseId: string): Promise<CheckoutMark | null> {
    const row = await this.prisma.purchase.findUnique({ where: { purchaseId }, select: { checkoutAt: true, checkoutRefusal: true } });
    if (row === null) return null;
    const { checkoutAt, checkoutRefusal } = markRowSchema.parse(row);
    // Отказ без времени показывать нечем: строка хронологии стоит во времени проверки.
    return checkoutAt === null ? null : { at: checkoutAt, refusal: checkoutRefusal };
  }

  private async timeline(purchase: StoredPurchase): Promise<TimelineEntry[]> {
    const mark = await this.of(purchase.purchaseId);
    if (mark === null) return [];
    const text = mark.refusal === null ? PASSED_TEXT : `Предварительная проверка: отказ — ${LABELS.get(mark.refusal) ?? mark.refusal}`;
    return [{ at: mark.at, kind: "checkout", text, actorName: null }];
  }
}
