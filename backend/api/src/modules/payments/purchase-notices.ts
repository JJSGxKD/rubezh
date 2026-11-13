import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { NotificationPayload } from "../notifications/notification-kinds.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { PaymentsHooks, type RefundDone, type SupportAction } from "./payments-hooks.js";
import type { StoredPurchase } from "./purchase-types.js";

/**
 * Сообщение игроку о компенсации и возврате звёзд (docs/35-stage4-plan.md Р209,
 * WP53, tasks/T-0436): короткое извинение с суммой — строкой ленты и, по
 * выбору игрока, сообщением бота (`notifications-bot`, ключ `bot.teamMessage`).
 *
 * Пишем о двух вещах: компенсация начислена (событие поддержки `compensate`)
 * и звёзды вернулись по решению поддержки или из-за товара, которого больше
 * нет (`onRefundDone`). Автоматические возвраты — тестовая оплата, неиспользованный
 * второй шанс, лишняя оплата, внешний возврат игрока — игрок не заказывал и
 * ждать извинений не должен.
 *
 * Один раз: ключ события ленты — действие и покупка, повтор события строку и
 * дубль в бота не удваивает. Сбой записи — предупреждение в логе, а не
 * исключение: деньги уже ушли, и лента не должна ни откатить их, ни уронить
 * задание очереди оплаты.
 */

type Delivered = NotificationPayload<"purchase_support">;

@Injectable()
export class PurchaseNotices implements OnModuleInit {
  private readonly logger = new Logger("payments");

  constructor(
    private readonly hooks: PaymentsHooks,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.hooks.onSupport("purchase-notices", (action) => this.onSupport(action));
    this.hooks.onRefundDone("purchase-notices", (event) => this.onRefundDone(event));
  }

  private async onSupport(action: SupportAction): Promise<void> {
    const { purchase } = action;
    // Дата в тексте — день оплаты: без оплаты и без самоцветов извиняться не за что.
    if (action.kind !== "compensate" || action.gems === undefined || action.gems <= 0 || purchase.paidAt === null) return;
    await this.deliver(purchase, { action: "compensated", stars: purchase.chargedStars, gems: action.gems, paidAt: purchase.paidAt.toISOString(), reason: null, revoked: false }, action.at);
  }

  private async onRefundDone(event: RefundDone): Promise<void> {
    const { purchase } = event;
    const reason = purchase.refundReason;
    if (purchase.paidAt === null || (reason !== "manual" && reason !== "undeliverable")) return;
    await this.deliver(purchase, { action: "refunded", stars: purchase.chargedStars, gems: 0, paidAt: purchase.paidAt.toISOString(), reason, revoked: event.revoked }, event.at);
  }

  private async deliver(purchase: StoredPurchase, payload: Delivered, at: Date): Promise<void> {
    try {
      await this.notifications.deliver({ accountId: purchase.accountId, kind: "purchase_support", payload, dedupeKey: `purchase_support:${payload.action}:${purchase.purchaseId}`, at });
    } catch (error: unknown) {
      this.logger.warn(
        JSON.stringify({ module: "payments", event: "purchase_notice_failed", purchaseId: purchase.purchaseId, action: payload.action, reason: error instanceof Error ? error.message : "unknown" }),
      );
    }
  }
}
