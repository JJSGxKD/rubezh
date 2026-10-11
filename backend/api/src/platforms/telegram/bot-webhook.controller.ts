import { timingSafeEqual } from "node:crypto";
import { Body, Controller, HttpCode, Inject, Logger, Post, Req } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { DisabledError, UnauthorizedError, UnavailableError } from "../../common/domain-error.js";
import { updateSchema } from "./telegram-bot-api.js";
import { BotUpdateQueue } from "./bot-update-queue.js";
import { Public } from "../../common/access.js";

/**
 * Вебхук бота (docs/28-diagnostics.md §6.1.3–§6.1.4).
 *
 * - **Секретный токен** из заголовка `X-Telegram-Bot-Api-Secret-Token` —
 *   единственная защита: неугадываемый путь ею не считается. Без токена
 *   обновление отклоняется, не доходя до разбора.
 * - **Сначала очередь, потом ответ.** Обновление записано в Redis до 200,
 *   иначе перезапуск процесса терял бы его, в том числе оплату. Повторы одного
 *   `update_id` отсекает id задания. Сводка рендерится секунды, выгрузка —
 *   минуты; их разбирает воркер очереди, а не запрос. Redis недоступен — 503,
 *   и Telegram повторит доставку сам.
 */

/** Минимальная форма запроса Fastify — см. domain-error.filter.ts. */
interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
}

@Controller("bot")
export class BotWebhookController {
  private readonly logger = new Logger("bot");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly updates: BotUpdateQueue,
  ) {}

  // Открыт наружу по замыслу: обновления шлёт Telegram, а не игрок. Проверка
  // — секретный токен в заголовке, её делает сам обработчик.
  @Public()
  @Post("webhook")
  @HttpCode(200)
  async receive(@Req() request: unknown, @Body() body: unknown): Promise<{ data: { accepted: boolean } }> {
    // Вебхук не включён — эндпоинта для внешнего мира нет.
    if (this.config.telegram.updates !== "webhook") throw new DisabledError("Вебхук бота выключен");
    const header = (request as WebhookRequest).headers["x-telegram-bot-api-secret-token"];
    if (typeof header !== "string" || !sameSecret(header, this.config.telegram.webhookSecret)) {
      throw new UnauthorizedError("Неверный токен вебхука");
    }

    const update = updateSchema.safeParse(body);
    // Непонятное обновление — «принято»: иначе Telegram повторял бы его, а
    // разобрать его лучше не станет.
    if (!update.success) return { data: { accepted: false } };
    try {
      await this.updates.enqueue(update.data);
    } catch (error: unknown) {
      // Не записано — «принято» не отвечаем: Telegram повторит доставку, а
      // повтор отсечёт id задания, если запись всё же дошла.
      this.logger.warn(
        JSON.stringify({ module: "bot", event: "bot_update_enqueue_failed", updateId: update.data.update_id, reason: error instanceof Error ? error.message : "unknown" }),
      );
      throw new UnavailableError("Очередь обновлений недоступна");
    }
    return { data: { accepted: true } };
  }
}

/** Сравнение за постоянное время: по времени ответа токен не подбирается. */
function sameSecret(received: string, expected: string): boolean {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
