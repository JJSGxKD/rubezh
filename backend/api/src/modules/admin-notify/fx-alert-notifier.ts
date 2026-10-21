import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { FxHooks, type FxAlert } from "../fx/fx-hooks.js";
import { NotifyTargets } from "../settings/notify-targets.js";
import { FeatureSwitches } from "../settings/feature-switches.js";
import { TELEGRAM_BOT_API, type TelegramBotApi } from "../../platforms/telegram/telegram-bot-api.js";

/**
 * Алерты курсов в общий чат команды (`ADMIN_CHAT_ID`, docs/35-stage4-plan.md,
 * §3.12): скачок, который не приняли, устаревший или просроченный курс,
 * молчащий источник, расход месячного лимита источника на 80% и 100%.
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
    private readonly targets: NotifyTargets,
    private readonly switches: FeatureSwitches,
    private readonly hooks: FxHooks,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set">,
    @Inject(TELEGRAM_BOT_API) private readonly api: FxAlertApi,
  ) {}

  /** Алерт уйдёт сейчас: опрос курсов включён и общий чат задан. */
  get enabled(): boolean {
    return this.possible && this.switches.fxPolling() && this.targets.chats().general !== null;
  }

  /** Токен — до перезапуска, опрос и чат — на ходу из панели: они проверяются при отправке. */
  private get possible(): boolean {
    return this.config.telegram.botToken !== "";
  }

  onModuleInit(): void {
    if (this.possible) this.hooks.onAlert("admin-notify", (alert) => this.deliver(alert));
  }

  async deliver(alert: FxAlert): Promise<void> {
    const chat = this.targets.chats().general;
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
    case "source_budget":
      // Своё окно на месяц и порог: порог 80% не глушит сообщение о 100%, а новый месяц — оба.
      return `budget:${alert.source}:${alert.month}:${String(alert.threshold)}`;
  }
}

/** Как источник называется для человека; незнакомый называется кодом. */
const SOURCE_NAMES: Record<string, string> = {
  coingecko: "CoinGecko",
  cbr: "ЦБ РФ",
  ecb: "ЕЦБ",
  erapi: "ExchangeRate-API",
  tonapi: "TON API",
  binance: "Binance",
};

/** Месяц в двух падежах: «за октябрь» и «до 1 ноября». */
const MONTHS: readonly (readonly [nominative: string, genitive: string])[] = [
  ["январь", "января"],
  ["февраль", "февраля"],
  ["март", "марта"],
  ["апрель", "апреля"],
  ["май", "мая"],
  ["июнь", "июня"],
  ["июль", "июля"],
  ["август", "августа"],
  ["сентябрь", "сентября"],
  ["октябрь", "октября"],
  ["ноябрь", "ноября"],
  ["декабрь", "декабря"],
];

/** Число с неразрывным пробелом между разрядами: «10 000» не разорвёт перенос строки. */
function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** `ГГГГ-ММ` → «за октябрь» и «до 1 ноября»; декабрь кончается 1 января. */
function monthPhrases(month: string): { name: string; until: string } {
  const index = Number(month.slice(5, 7)) - 1;
  const current = MONTHS[index];
  const next = MONTHS[(index + 1) % 12];
  if (current === undefined || next === undefined) return { name: month, until: "начала следующего месяца" };
  return { name: current[0], until: `1 ${next[1]}` };
}

function budgetText(alert: Extract<FxAlert, { kind: "source_budget" }>): string {
  const source = SOURCE_NAMES[alert.source] ?? alert.source;
  const { name, until } = monthPhrases(alert.month);
  if (alert.threshold === 100) {
    return `🛑 ${source}: лимит ${grouped(alert.perMonth)} запросов за ${name} исчерпан. Источник молчит до ${until}, курс берут остальные`;
  }
  const percent = Math.floor((alert.used * 100) / alert.perMonth);
  return `📊 ${source}: израсходовано ${grouped(alert.used)} из ${grouped(alert.perMonth)} запросов за ${name} (${String(percent)}%). Курс опрашивается реже, до ${until} хватит`;
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
    case "source_budget":
      return budgetText(alert);
  }
}
