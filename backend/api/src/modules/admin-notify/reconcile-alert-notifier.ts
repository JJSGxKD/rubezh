import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { TELEGRAM_BOT_API, type TelegramBotApi } from "../../platforms/telegram/telegram-bot-api.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import type { DiscrepancyKind } from "../payments/payment-reconcile.js";
import { PaymentsHooks, type ReconcileFound } from "../payments/payments-hooks.js";
import { NotifyTargets } from "../settings/notify-targets.js";

/**
 * Сообщение команде о новых расхождениях сверки оплат с выпиской площадки
 * (docs/35-stage4-plan.md, Р209, tasks/T-0433): в поток «Покупки»
 * (`notify.chat.payments`), а пока он не задан — в общий чат, как у
 * остальных потоков (`NotifyTargets`).
 *
 * Одно сообщение на сверку, нашедшую **новые** расхождения. Без дедупликации:
 * сообщение шлёт сама сверка, а повторные находки она за новые не считает
 * (уникальный ключ расхождения), так что повторять нечему. Образец —
 * `PaymentsAlertNotifier`, но свой класс: своё событие, свой текст.
 */

const SEND_TIMEOUT_MS = 10_000;

export type ReconcileAlertApi = Pick<TelegramBotApi, "sendMessage">;

const PLATFORM_NAMES: Readonly<Record<PlatformId, string>> = {
  telegram: "Telegram",
  max: "MAX",
  vk: "VK",
  web: "веб",
};

/** Подписи видов — в порядке строк сообщения. */
const KIND_LINES: readonly { kind: DiscrepancyKind; label: string }[] = [
  { kind: "charged_unrecorded", label: "Списано, но не записано" },
  { kind: "recorded_missing", label: "Записано, но нет в выписке" },
  { kind: "refund_unrecorded", label: "Возврат в Telegram, но не у нас" },
];

@Injectable()
export class ReconcileAlertNotifier implements OnModuleInit {
  private readonly logger = new Logger("admin-notify");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly targets: NotifyTargets,
    private readonly hooks: PaymentsHooks,
    @Inject(TELEGRAM_BOT_API) private readonly api: ReconcileAlertApi,
  ) {}

  onModuleInit(): void {
    // Токен — до перезапуска, адрес чата — на ходу из панели: он проверяется при отправке.
    if (this.config.telegram.botToken === "") return;
    this.hooks.onReconcileFound("admin-notify", (event) => this.deliver(event));
  }

  /** Не бросает: расхождения уже записаны, и упавшее сообщение не должно ронять сверку. */
  async deliver(event: ReconcileFound): Promise<void> {
    const fields = { platform: event.platform, found: event.found };
    const chat = this.targets.chats().payments;
    if (chat === null) {
      this.logger.warn(JSON.stringify({ module: "admin-notify", event: "reconcile_alert_no_chat", ...fields }));
      return;
    }
    try {
      await this.api.sendMessage(chat, reconcileAlertText(event), AbortSignal.timeout(SEND_TIMEOUT_MS));
      this.logger.log(JSON.stringify({ module: "admin-notify", event: "reconcile_alert_sent", ...fields }));
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "admin-notify", event: "reconcile_alert_failed", ...fields, reason: error instanceof Error ? error.message : "unknown" }));
    }
  }
}

/** Текст — для человека в чате: сколько новых, каких видов (только ненулевые), сколько открыто и куда идти. */
export function reconcileAlertText(event: ReconcileFound): string {
  const lines = KIND_LINES.flatMap(({ kind, label }) => {
    const count = event.kinds[kind] ?? 0;
    return count > 0 ? [`${label}: ${String(count)}`] : [];
  });
  return [
    `🧾 Сверка с ${PLATFORM_NAMES[event.platform]}: новых расхождений — ${String(event.found)}`,
    ...lines,
    `Открытых всего: ${String(event.open)}`,
    "Разобрать: панель → «Платежи» → «Расхождения».",
  ].join("\n");
}
