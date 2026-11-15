import { Module } from "@nestjs/common";
import { EventsModule } from "../events/events.module.js";
import { BotMessageEvents } from "./bot-message-events.js";
import { BotMessagePolicy } from "./bot-message-policy.js";
import { BotMessages } from "./bot-messages.service.js";

/**
 * Общие правила сообщений бота (docs/35-stage4-plan.md Р199, WP52): звук и
 * тихие часы, событие `bot_message_sent`, сборка оформленного сообщения.
 * Сценарии — дубль уведомлений, итог сезона, рекорд, новости — подключают этот
 * модуль и не знают площадку: сообщение уходит через порт `Messenger`.
 */
@Module({
  imports: [EventsModule],
  providers: [BotMessagePolicy, BotMessageEvents, BotMessages],
  exports: [BotMessagePolicy, BotMessageEvents, BotMessages],
})
export class BotMessagesModule {}
