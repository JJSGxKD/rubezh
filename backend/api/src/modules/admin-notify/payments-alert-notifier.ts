import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { PaymentsHooks, type StuckPurchase } from "../payments/payments-hooks.js";
import { NotifyTargets } from "../settings/notify-targets.js";
import { TELEGRAM_BOT_API, type TelegramBotApi } from "../../platforms/telegram/telegram-bot-api.js";

/**
 * Сообщение команде о покупке, которую проход довыдачи не смог закрыть
 * выдачей (tasks/T-0003): в поток «Покупки» (`notify.chat.payments`), а пока
 * он не задан — в общий чат, как у остальных потоков (`NotifyTargets`).
 *
 * **Одно сообщение на покупку за семь суток.** Проход повторяет выдачу каждые
 * пять минут, и покупка с упавшей выдачей сообщала бы о себе каждый раз. Ключ
 * ставит `SET NX EX`: две реплики не пришлют сообщение дважды. Не ушло — ключ
 * снимается, и следующий проход повторит: потерянное сообщение хуже лишнего.
 */

const QUIET_SEC = 7 * 24 * 60 * 60;
const SEND_TIMEOUT_MS = 10_000;

export type PaymentsAlertApi = Pick<TelegramBotApi, "sendMessage">;

@Injectable()
export class PaymentsAlertNotifier implements OnModuleInit {
  private readonly logger = new Logger("admin-notify");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly targets: NotifyTargets,
    private readonly hooks: PaymentsHooks,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "del">,
    @Inject(TELEGRAM_BOT_API) private readonly api: PaymentsAlertApi,
  ) {}

  onModuleInit(): void {
    // Токен — до перезапуска, адрес чата — на ходу из панели: он проверяется при отправке.
    if (this.config.telegram.botToken !== "") this.hooks.onStuck("admin-notify", (purchase) => this.deliver(purchase));
  }

  /** Не бросает: нет чата, Redis или Telegram — в лог, и проход идёт дальше. */
  async deliver(purchase: StuckPurchase): Promise<void> {
    const chat = this.targets.chats().payments;
    if (chat === null) {
      this.logger.warn(JSON.stringify({ module: "admin-notify", event: "payments_alert_no_chat", purchaseId: purchase.purchaseId }));
      return;
    }
    const key = `payments:stuck-alert:${purchase.purchaseId}`;
    try {
      if ((await this.redis.set(key, "1", "EX", QUIET_SEC, "NX")) === null) return;
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "admin-notify", event: "payments_alert_skipped", purchaseId: purchase.purchaseId, reason: reasonOf(error) }));
      return;
    }
    try {
      await this.api.sendMessage(chat, stuckPurchaseText(purchase), AbortSignal.timeout(SEND_TIMEOUT_MS));
      this.logger.log(JSON.stringify({ module: "admin-notify", event: "payments_alert_sent", purchaseId: purchase.purchaseId, reason: purchase.reason }));
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "admin-notify", event: "payments_alert_failed", purchaseId: purchase.purchaseId, reason: reasonOf(error) }));
      await this.redis.del(key).catch(() => 0);
    }
  }
}

/** Текст — для человека в чате: что не выдано, кому и что с этим делать. */
export function stuckPurchaseText(purchase: StuckPurchase): string {
  return [
    "⚠️ Покупка не выдана",
    `Товар: ${purchase.sku ?? purchase.product}, ${String(purchase.chargedStars)} ⭐`,
    `Аккаунт: ${purchase.accountId}`,
    `Оплачена: ${utcMinute(purchase.paidAt)}`,
    `Причина: ${purchase.reason}`,
    purchase.reason === "undeliverable" ? "Звёзды возвращаются автоматически." : "Проход повторяет выдачу каждые 5 минут; нужна проверка.",
  ].join("\n");
}

/** ГГГГ-ММ-ДД ЧЧ:ММ по UTC: сервер и логи в UTC, команда сверяет покупку по ним. */
function utcMinute(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
