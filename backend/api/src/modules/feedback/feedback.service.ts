import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { RateLimitedError, UnavailableError, ValidationError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { describeDbError } from "../../infra/database.js";
import type { IngestIdentity } from "../ingest/ingest.guard.js";
import { INGEST_LIMITS } from "../ingest/ingest-limits.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import type { ChatTarget } from "../../platforms/telegram/chat-target.js";
import { TELEGRAM_BOT_API, type TelegramBotApi } from "../../platforms/telegram/telegram-bot-api.js";
import { submitFeedbackSchema } from "./dto/feedback.dto.js";
import { FEEDBACK_REPOSITORY, type FeedbackRepository } from "./feedback.repository.js";
import { feedbackMessage } from "./feedback-message.js";

/** Сколько ждём Telegram: отзыв уже записан, ответ игроку держать незачем. */
const NOTIFY_TIMEOUT_MS = 5_000;

export type FeedbackBotApi = Pick<TelegramBotApi, "sendMessage">;

/**
 * Приём отзывов игроков (docs/29-admin-panel.md §6).
 *
 * Отзыв ложится в базу **и** уходит в чат администраторов. База — чтобы
 * собрать сводку за неделю и не потерять отзыв, когда Telegram недоступен;
 * чат — чтобы прочитать сегодня. Поэтому неудачная отправка в чат не роняет
 * запрос: запись уже есть, а в логе останется причина.
 */
@Injectable()
export class FeedbackService {
  private readonly logger = new Logger("feedback");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FEEDBACK_REPOSITORY) private readonly repository: FeedbackRepository,
    @Inject(TELEGRAM_BOT_API) private readonly api: FeedbackBotApi,
    private readonly limiter: RateLimiter,
  ) {}

  async receive(body: unknown, identity: IngestIdentity, signal?: AbortSignal): Promise<{ feedbackId: string }> {
    const parsed = submitFeedbackSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Некорректный отзыв");

    const feedback = parsed.data;
    if (Object.keys(feedback.answers).length === 0 && feedback.text.trim() === "") {
      throw new ValidationError("Пустой отзыв: ни ответов, ни текста");
    }
    await this.enforceLimits(feedback.installId, identity.platformUserId);

    const feedbackId = randomUUID();
    try {
      await this.repository.insert({
        feedbackId,
        installId: feedback.installId,
        platformUserId: identity.platformUserId,
        platform: feedback.platform,
        appVersion: feedback.appVersion,
        answers: feedback.answers,
        text: feedback.text.trim(),
        runs: feedback.runs,
      });
    } catch (error: unknown) {
      this.logger.error(JSON.stringify({ module: "feedback", event: "insert_failed", reason: describeDbError(error) }));
      throw new UnavailableError("Отзыв не сохранился, попробуйте позже");
    }

    await this.notify(feedback.text.trim(), feedback.answers, feedback.runs, identity.platformUserId, signal);
    return { feedbackId };
  }

  /** Лимиты те же, что у отчётов: отзывы приходят редко, а спамить ими легко. */
  private async enforceLimits(installId: string, platformUserId: string | null): Promise<void> {
    const limits = INGEST_LIMITS.feedback;
    const byInstall = await this.limiter.consume(limits.install, installId);
    const byUser = platformUserId === null ? true : await this.limiter.consume(limits.user, platformUserId);
    if (!byInstall || !byUser) throw new RateLimitedError("Слишком много отзывов, попробуйте позже");
  }

  private async notify(
    text: string,
    answers: Record<string, string>,
    runs: number,
    platformUserId: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    const chat: ChatTarget | null = this.config.telegram.chats.feedback;
    if (chat === null || this.config.telegram.botToken === "") return;

    try {
      await withTimeout(
        this.api.sendMessage(chat, feedbackMessage({ answers, text, runs, platformUserId }), signal),
        NOTIFY_TIMEOUT_MS,
        "feedback",
      );
    } catch (error: unknown) {
      // Отзыв уже в базе: чат — второй адрес, а не единственный.
      this.logger.warn(
        JSON.stringify({ module: "feedback", event: "notify_failed", reason: error instanceof Error ? error.message : "unknown" }),
      );
    }
  }
}
