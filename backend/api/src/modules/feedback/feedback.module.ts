import { Module } from "@nestjs/common";
import { BotModule } from "../bot/bot.module.js";
import { FeedbackBotCommand } from "./feedback-bot.command.js";
import { FeedbackController } from "./feedback.controller.js";
import { FEEDBACK_REPOSITORY, PrismaFeedbackRepository } from "./feedback.repository.js";
import { FeedbackService } from "./feedback.service.js";

/**
 * Обратная связь от игроков: форма в клиенте, запись в Postgres и сообщение в
 * чат администраторов (docs/29-admin-panel.md §6). Выгрузку отзывов себе в
 * Telegram делает команда бота — она живёт в модуле выгрузки.
 */
@Module({
  imports: [BotModule],
  controllers: [FeedbackController],
  providers: [FeedbackService, FeedbackBotCommand, { provide: FEEDBACK_REPOSITORY, useClass: PrismaFeedbackRepository }],
  exports: [FEEDBACK_REPOSITORY],
})
export class FeedbackModule {}
