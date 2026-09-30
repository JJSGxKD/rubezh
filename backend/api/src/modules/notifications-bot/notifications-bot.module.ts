import { Module } from "@nestjs/common";
import { AccountSettingsModule } from "../account-settings/account-settings.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { MessagingModule } from "../messaging/messaging.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { BotNotifyQueue } from "./bot-notify-queue.js";
import { BotNotifySender } from "./bot-notify-sender.js";

/**
 * Дубль уведомлений в бота по выбору игрока (docs/35-stage4-plan.md Р51,
 * WP28). Своим модулем, а не частью ленты: лента остаётся листом и ни от
 * площадок, ни от настроек не зависит, а сюда приходит через `onCreated`.
 */
@Module({
  imports: [AuthModule, NotificationsModule, MessagingModule, AccountSettingsModule],
  providers: [BotNotifySender, BotNotifyQueue],
})
export class NotificationsBotModule {}
