import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { FxHooks, type FxAlert } from "../fx/fx-hooks.js";
import { TELEGRAM_BOT_API, type TelegramBotApi } from "../../platforms/telegram/telegram-bot-api.js";

/**
 * Алерты курсов в общий чат команды (`ADMIN_CHAT_ID`, docs/35-stage4-plan.md,
 * §3.12): скачок, который не приняли, устаревший или просроченный курс,
 * молчащий источник.
 *
 * **Окно тишины.** Проход обновления идёт раз в минуту, и устаревший курс
 * сообщал бы о себе шестьдесят раз в час. Один алерт на причину — раз в
 * шесть часов, одним `SET NX EX`: две реплики не пришлют его дважды.
 */

const QUIET_SEC = 6 * 60 * 60;
const SEND_TIMEOUT_MS = 10_000;

export type FxAlertApi = Pick<TelegramBotApi, "sendMessage">;

@Injectable()
export class FxAlertNotifier implements OnModuleInit {
  private readonly logger = new Logger("admin-notify");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly hooks: FxHooks,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set">,
    @Inject(TELEGRAM_BOT_API) private readonly api: FxAlertApi,
  ) {}

  get enabled(): boolean {
    return this.config.fx.enabled && this.config.telegram.chats.general !== null && this.config.telegram.botToken !== "";
  }

  onModuleInit(): void {
    if (this.enabled) this.hooks.onAlert("admin-notify", (alert) => this.deliver(alert));
  }

  async deliver(alert: FxAlert): Promise<void> {
    const chat = this.config.telegram.chats.general;
    if (chat === null) return;
    if ((await this.redis.set(`notify:fx:${keyOf(alert)}`, "1", "EX", QUIET_SEC, "NX")) === null) return;
    await this.api.sendMessage(chat, fxAlertText(alert), AbortSignal.timeout(SEND_TIMEOUT_MS));
    this.logger.log(JSON.stringify({ module: "admin-notify", event: "fx_alert_sent", kind: alert.kind }));
  }
}

function keyOf(alert: FxAlert): string {
  switch (alert.kind) {
    case "rate_rejected":
      return `rejected:${alert.currency}`;
    case "rate_stale":
      return `stale:${alert.currency}:${alert.purpose ?? "rate"}:${alert.state}`;
    case "source_failed":
      return `source:${alert.source}`;
  }
}

const STATE_TEXT: Record<Extract<FxAlert, { kind: "rate_stale" }>["state"], string> = {
  stale: "устарел — цены стоят, продажи идут",
  expired: "просрочен — продавать по нему больше нельзя",
  missing: "не задан вовсе",
};

/** Текст — для человека в чате: что случилось и что с этим делать. */
export function fxAlertText(alert: FxAlert): string {
  switch (alert.kind) {
    case "rate_rejected":
      return alert.reason === "jump_unconfirmed"
        ? `💱 Курс ${alert.currency} не принят: скачок до ${alert.candidate} $ (было ${alert.previous ?? "—"}) не подтвердил второй источник. Цены стоят на прежнем курсе.`
        : `💱 Курс ${alert.currency} не принят: источники расходятся, кандидат ${alert.candidate} $. Цены стоят на прежнем курсе.`;
    case "rate_stale":
      return alert.purpose === null
        ? `⏳ Курс ${alert.currency} ${STATE_TEXT[alert.state]}. Источники молчат — проверьте их в панели.`
        : `⏳ Заданный курс ${alert.currency} (${alert.purpose === "price" ? "цена для игрока" : "выплата нам"}) ${STATE_TEXT[alert.state]}. Поставьте новый в панели.`;
    case "source_failed":
      return `📡 Источник курсов ${alert.source} не ответил: ${alert.reason}. Остальные продолжают.`;
  }
}
