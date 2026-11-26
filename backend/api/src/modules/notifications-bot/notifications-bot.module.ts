import { Module } from "@nestjs/common";
import { AccountSettingsModule } from "../account-settings/account-settings.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { BotMessagesModule } from "../bot-messages/bot-messages.module.js";
import { MessagingModule } from "../messaging/messaging.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { BotNotifyQueue } from "./bot-notify-queue.js";
import { BotNotifySender } from "./bot-notify-sender.js";

/**
 * Дубль уведомлений в бота по выбору игрока (docs/35-stage4-plan.md Р51,
 * WP28). Своим модулем, а не частью ленты: лента остаётся листом и ни от
 * площадок, ни от настроек не зависит, а сюда приходит через `onCreated`.
 * Звук, тихие часы и событие `bot_message_sent` — правила `BotMessagesModule`
 * (Р199, tasks/T-0394). Очередь `notifications-bot` отдаётся и модулю живых карточек:
 * лимитер у неё один на дубль и карточки.
 */
@Module({
  imports: [AuthModule, NotificationsModule, MessagingModule, AccountSettingsModule, BotMessagesModule],
  providers: [BotNotifySender, BotNotifyQueue],
  // Очередь нужна живым карточкам (Р199, tasks/T-0395): правки и отправки идут общим темпом с дублем.
  exports: [BotNotifyQueue],
})
export class NotificationsBotModule {}
