import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { AppConfig } from "../../config/app-config.js";
import { MAX_WEBHOOK_PATH, SECRETS } from "../../modules/secrets/secret-catalog.js";
import type { SecretsReader } from "../../modules/secrets/secrets.service.js";
import type { MaxBotApi } from "./max-bot-api.js";
import { maxSecretOf } from "./max-secret.js";
import { BOT_STARTED, SUBSCRIBED_UPDATE_TYPES } from "./max-update.js";

/**
 * Подписка вебхука у MAX (docs/35-stage4-plan.md Р188, tasks/T-0379), по образцу
 * `setWebhook` Telegram, но без отдельной команды: сервер сам оформляет её, когда
 * есть ключ бота, секрет вебхука и публичный адрес API (`PUBLIC_API_URL`, тот же,
 * что у вебхука Telegram).
 *
 * - **При старте и каждую минуту.** Ключ и секрет меняются в панели без
 *   перезапуска, поэтому проход идёт по таймеру; смена ключа, секрета или адреса
 *   даёт новую подписку, а без перемен проход ничего не спрашивает у MAX.
 * - **Идемпотентна.** При первом проходе процесса спрашиваем `GET /subscriptions`:
 *   подписка на тот же адрес с типом `bot_started` уже есть — ничего не делаем и
 *   не плодим вторую. Секрет подписки через API не виден, поэтому «секрет
 *   сменился, пока сервер не работал» этим не поймать: новый секрет создаётся в
 *   панели, то есть в работающем сервере, и подписка у него обновится сразу.
 * - **Ошибка — в лог, не в падение.** MAX недоступен — старт сервера не ломается,
 *   повтор — на следующем проходе. Ни ключа, ни секрета в лог не попадает.
 *
 * В документации MAX не описано, что делает второй `POST /subscriptions` на тот
 * же адрес: заменяет подписку или заводит вторую. Поэтому на смену секрета и
 * ключа он отправляется, а на пустой проход — нет.
 */

const REFRESH_MS = 60_000;

export type SubscriptionOutcome = "subscribed" | "present" | "skipped" | "failed";

export class MaxSubscriptionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("max");
  private timer: NodeJS.Timeout | null = null;
  /** что оформлено в этом процессе: ключ, секрет и адрес; `null` — ещё ничего */
  private applied: string | null = null;
  private running: Promise<SubscriptionOutcome> | null = null;
  private warnedAddress = false;

  constructor(
    private readonly api: Pick<MaxBotApi, "subscriptions" | "subscribe">,
    private readonly secrets: Pick<SecretsReader, "get">,
    private readonly config: Pick<AppConfig, "telegram">,
  ) {}

  onApplicationBootstrap(): void {
    // Старт не ждёт MAX: у запросов свой потолок, а сервер должен подняться и без него.
    void this.ensure();
    this.timer = setInterval(() => void this.ensure(), REFRESH_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** Один проход; не бросает. Одновременные проходы — один. */
  async ensure(): Promise<SubscriptionOutcome> {
    if (this.running !== null) return await this.running;
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return await this.running;
  }

  private async run(): Promise<SubscriptionOutcome> {
    const token = this.secrets.get(SECRETS.maxBotToken);
    const stored = this.secrets.get(SECRETS.maxWebhookSecret);
    if (token === null || stored === null) return "skipped";
    const url = this.webhookUrl();
    if (url === null) return "skipped";

    const secret = maxSecretOf(stored);
    const key = `${token}\n${secret}\n${url}`;
    if (key === this.applied) return "present";
    try {
      // Первый проход процесса: подписка, оформленная раньше, уже может стоять.
      if (this.applied === null && (await this.exists(url))) {
        this.applied = key;
        return "present";
      }
      await this.api.subscribe(url, secret, SUBSCRIBED_UPDATE_TYPES);
      this.applied = key;
      this.logger.log(JSON.stringify({ module: "max", event: "max_subscribed", url }));
      return "subscribed";
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "max", event: "max_subscribe_failed", reason: error instanceof Error ? error.message : "unknown" }));
      return "failed";
    }
  }

  /** Подписка на этот адрес с типом `bot_started` (или на все типы) уже есть. */
  private async exists(url: string): Promise<boolean> {
    const subscriptions = await this.api.subscriptions();
    return subscriptions.some((item) => item.url === url && (item.updateTypes === null || item.updateTypes.includes(BOT_STARTED)));
  }

  /** Адрес вебхука; MAX принимает только https, поэтому без публичного https-адреса подписки нет. */
  private webhookUrl(): string | null {
    const base = this.config.telegram.publicApiUrl.replace(/\/+$/, "");
    if (base.startsWith("https://")) return `${base}${MAX_WEBHOOK_PATH}`;
    if (!this.warnedAddress) {
      this.warnedAddress = true;
      this.logger.warn(JSON.stringify({ module: "max", event: "max_subscribe_skipped", reason: "PUBLIC_API_URL не задан или не https" }));
    }
    return null;
  }
}
