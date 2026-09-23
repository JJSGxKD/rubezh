import { timingSafeEqual } from "node:crypto";
import { Body, Controller, HttpCode, Inject, Injectable, Logger, Post, Req } from "@nestjs/common";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { DisabledError, UnauthorizedError } from "../../common/domain-error.js";
import { REDIS } from "../../infra/redis.js";
import { updateSchema } from "../telegram/telegram-bot-api.js";
import { BotRouter } from "./bot-router.js";
import { Public } from "../roles/permission.guard.js";

/**
 * Вебхук бота (docs/28-diagnostics.md §6.1.3–§6.1.4).
 *
 * - **Секретный токен** из заголовка `X-Telegram-Bot-Api-Secret-Token` —
 *   единственная защита: неугадываемый путь ею не считается. Без токена
 *   обновление отклоняется, не доходя до разбора.
 * - **Ответ сразу.** Сводка рендерится секунды, выгрузка — минуты; Telegram
 *   считает медленный ответ ошибкой и повторяет обновление. Поэтому
 *   обработчики работают после ответа, а повтор одного `update_id` отсекает
 *   короткий ключ в Redis.
 */

/** Сколько помнить обработанные обновления: Telegram повторяет неудачную доставку до суток, но первые попытки — в минуты. */
const DEDUPE_TTL_SEC = 60 * 60;

@Injectable()
export class BotUpdateDedupe {
  private readonly logger = new Logger("bot");

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** `true` — обновление видим впервые. Redis недоступен — обрабатываем: лучше повтор, чем потеря команды. */
  async claim(updateId: number): Promise<boolean> {
    try {
      return (await this.redis.set(`bot:update:${updateId}`, "1", "EX", DEDUPE_TTL_SEC, "NX")) !== null;
    } catch (error: unknown) {
      this.logger.warn(
        JSON.stringify({ module: "bot", event: "dedupe_unavailable", reason: error instanceof Error ? error.message : "unknown" }),
      );
      return true;
    }
  }
}

/** Минимальная форма запроса Fastify — см. domain-error.filter.ts. */
interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
}

@Controller("bot")
export class BotWebhookController {
  private readonly logger = new Logger("bot");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly router: BotRouter,
    private readonly dedupe: BotUpdateDedupe,
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
    if (!(await this.dedupe.claim(update.data.update_id))) return { data: { accepted: false } };

    void this.router.dispatch(update.data).catch((error: unknown) => {
      this.logger.error(
        JSON.stringify({ module: "bot", event: "dispatch_failed", reason: error instanceof Error ? error.message : "unknown" }),
      );
    });
    return { data: { accepted: true } };
  }
}

/** Сравнение за постоянное время: по времени ответа токен не подбирается. */
function sameSecret(received: string, expected: string): boolean {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
