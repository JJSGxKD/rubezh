import { timingSafeEqual } from "node:crypto";
import { Body, Controller, HttpCode, Inject, Logger, Post, Req } from "@nestjs/common";
import { Public } from "../../common/access.js";
import { DisabledError, UnauthorizedError, UnavailableError } from "../../common/domain-error.js";
import { SECRETS } from "../../modules/secrets/secret-catalog.js";
import { SECRETS_READER, type SecretsReader } from "../../modules/secrets/secrets.service.js";
import { maxSecretOf } from "./max-secret.js";
import { BOT_STARTED, botStartedSchema, updateTypeOf } from "./max-update.js";
import { MaxUpdateQueue } from "./max-update-queue.js";

/**
 * Вебхук бота MAX (docs/35-stage4-plan.md Р188, tasks/T-0379), по образцу
 * вебхука Telegram (`telegram/bot-webhook.controller.ts`).
 *
 * - **Секрет подписки** из заголовка `X-Max-Bot-Api-Secret` — единственная
 *   защита: неугадываемый путь ею не считается. Неверный секрет — 401 до разбора
 *   тела. Нет ключа бота или секрета — эндпоинта для внешнего мира нет (404):
 *   без секрета событие не от кого проверить.
 * - **Сначала очередь, потом ответ.** `bot_started` записан в Redis до 200, иначе
 *   перезапуск терял бы его. Redis недоступен — 503, и MAX повторит доставку (до
 *   10 раз за 8 часов, потом отпишет бота). Повтор отсекает id задания.
 * - **Прочие типы событий** — 200 без обработки: на них бот не подписан, и
 *   повторять их незачем.
 * - **Счётчик** `max_webhook{type,result}` — строкой лога, пока в бэкенде нет
 *   Prometheus (docs/22 §3.3): вид события — `bot_started`, `other` или `unknown`
 *   (тип не разобран), исход — из закрытого списка; ни игрока, ни кода в метке нет.
 */

/** Минимальная форма запроса Fastify — см. domain-error.filter.ts. */
interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
}

type WebhookType = "bot_started" | "other" | "unknown";
type WebhookResult = "accepted" | "ignored" | "invalid" | "unauthorized" | "unavailable";

/** Как часто в лог попадает отказ по секрету: перебор секрета не должен раздувать лог. */
const UNAUTHORIZED_LOG_EVERY_MS = 60_000;

@Controller("max")
export class MaxWebhookController {
  private readonly logger = new Logger("max");
  private lastUnauthorizedLogAt = 0;

  constructor(
    @Inject(SECRETS_READER) private readonly secrets: SecretsReader,
    private readonly updates: MaxUpdateQueue,
  ) {}

  // Открыт наружу по замыслу: события шлёт MAX, а не игрок. Проверка — секрет
  // в заголовке, её делает сам обработчик.
  @Public()
  @Post("webhook")
  @HttpCode(200)
  async receive(@Req() request: unknown, @Body() body: unknown): Promise<{ data: { accepted: boolean } }> {
    const token = this.secrets.get(SECRETS.maxBotToken);
    const secret = this.secrets.get(SECRETS.maxWebhookSecret);
    if (token === null || secret === null) throw new DisabledError("Вебхук бота MAX выключен");

    const header = (request as WebhookRequest).headers["x-max-bot-api-secret"];
    if (typeof header !== "string" || !sameSecret(header, maxSecretOf(secret))) {
      this.countUnauthorized();
      throw new UnauthorizedError("Неверный секрет вебхука");
    }

    const type = updateTypeOf(body);
    if (type !== BOT_STARTED) {
      this.count(type === null ? "unknown" : "other", "ignored");
      return { data: { accepted: false } };
    }
    const event = botStartedSchema.safeParse(body);
    // Непонятное событие — «принято»: MAX повторял бы его, а разобрать его лучше не станет.
    if (!event.success) {
      this.count("bot_started", "invalid");
      return { data: { accepted: false } };
    }
    try {
      await this.updates.enqueue(event.data);
    } catch (error: unknown) {
      // Не записано — «принято» не отвечаем: MAX повторит доставку, а повтор отсечёт id задания.
      this.logger.warn(JSON.stringify({ module: "max", event: "max_enqueue_failed", reason: error instanceof Error ? error.message : "unknown" }));
      this.count("bot_started", "unavailable");
      throw new UnavailableError("Очередь событий недоступна");
    }
    this.count("bot_started", "accepted");
    return { data: { accepted: true } };
  }

  private count(type: WebhookType, result: WebhookResult): void {
    this.logger.log(JSON.stringify({ module: "max", event: "max_webhook", type, result }));
  }

  private countUnauthorized(): void {
    const now = Date.now();
    if (now - this.lastUnauthorizedLogAt < UNAUTHORIZED_LOG_EVERY_MS) return;
    this.lastUnauthorizedLogAt = now;
    this.count("unknown", "unauthorized");
  }
}

/** Сравнение за постоянное время: по времени ответа секрет не подбирается. */
function sameSecret(received: string, expected: string): boolean {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
