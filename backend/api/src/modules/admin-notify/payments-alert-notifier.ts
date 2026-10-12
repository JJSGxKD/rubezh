import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { PaymentsHooks, type AbandonedJob, type StuckPurchase } from "../payments/payments-hooks.js";
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
 *
 * Так же — о задании очереди оплаты, брошенном после всех попыток
 * (tasks/T-0004): одно сообщение на задание за семь суток, ключ — его
 * `jobId`. Очередь задание больше не повторит, так что сообщение — единственный
 * сигнал, что запись оплаты или возврата не легла в базу.
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
    if (this.config.telegram.botToken === "") return;
    this.hooks.onStuck("admin-notify", (purchase) => this.deliver(purchase));
    this.hooks.onAbandoned("admin-notify", (job) => this.deliverAbandoned(job));
  }

  /** Не бросает: нет чата, Redis или Telegram — в лог, и проход идёт дальше. */
  async deliver(purchase: StuckPurchase): Promise<void> {
    await this.notify({
      key: `payments:stuck-alert:${purchase.purchaseId}`,
      text: stuckPurchaseText(purchase),
      fields: { purchaseId: purchase.purchaseId },
      reason: purchase.reason,
    });
  }

  /** Не бросает: задание брошено, и упавшее сообщение не должно ронять обработчик воркера. */
  async deliverAbandoned(job: AbandonedJob): Promise<void> {
    await this.notify({
      key: `payments:abandoned-alert:${job.jobId}`,
      text: abandonedJobText(job),
      fields: { jobId: job.jobId, chargeId: job.chargeId },
      reason: job.reason,
    });
  }

  private async notify(message: { key: string; text: string; fields: Record<string, unknown>; reason: string }): Promise<void> {
    const { key, text, fields, reason } = message;
    const chat = this.targets.chats().payments;
    if (chat === null) {
      this.logger.warn(JSON.stringify({ module: "admin-notify", event: "payments_alert_no_chat", ...fields }));
      return;
    }
    try {
      if ((await this.redis.set(key, "1", "EX", QUIET_SEC, "NX")) === null) return;
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "admin-notify", event: "payments_alert_skipped", ...fields, reason: reasonOf(error) }));
      return;
    }
    try {
      await this.api.sendMessage(chat, text, AbortSignal.timeout(SEND_TIMEOUT_MS));
      this.logger.log(JSON.stringify({ module: "admin-notify", event: "payments_alert_sent", ...fields, reason }));
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "admin-notify", event: "payments_alert_failed", ...fields, reason: reasonOf(error) }));
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

const ABANDONED_KINDS: Record<AbandonedJob["kind"], string> = {
  confirm: "подтверждение",
  refund: "возврат",
  refunded: "внешний возврат",
};

/** Текст — для человека в чате: какое задание, по какой оплате и что с этим делать. */
export function abandonedJobText(job: AbandonedJob): string {
  return [
    "⚠️ Задание оплаты брошено после всех попыток",
    `Вид: ${ABANDONED_KINDS[job.kind]}`,
    `Оплата: ${job.chargeId}`,
    `Покупка: ${job.purchaseId ?? "—"}`,
    `Причина: ${job.reason}`,
    "Нужна ручная сверка покупки.",
  ].join("\n");
}

/** ГГГГ-ММ-ДД ЧЧ:ММ по UTC: сервер и логи в UTC, команда сверяет покупку по ним. */
function utcMinute(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
