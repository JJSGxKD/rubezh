import { Module } from "@nestjs/common";
import { MessagingModule } from "../../modules/messaging/messaging.module.js";
import { BotModule } from "./bot.module.js";
import { TelegramMessagingHandler } from "./telegram-messaging.handler.js";

/** Обновления Telegram о разрешении писать → домен «можно писать». */
@Module({
  imports: [MessagingModule, BotModule],
  providers: [TelegramMessagingHandler],
})
export class TelegramMessagingModule {}
