import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { NotificationsCleaner } from "./notifications-cleaner.js";
import { NotificationsController } from "./notifications.controller.js";
import { NOTIFICATIONS_REPOSITORY, PrismaNotificationsRepository } from "./notifications.repository.js";
import { NotificationsService } from "./notifications.service.js";

/**
 * Лента уведомлений (docs/35-stage4-plan.md Р51, §3.17). Лист: сам ни от
 * кого из доменных модулей не зависит, а друзья, снаряжение и бусты пишут в
 * него через `NotificationsService.post`.
 */
@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsCleaner, { provide: NOTIFICATIONS_REPOSITORY, useClass: PrismaNotificationsRepository }],
  exports: [NotificationsService],
})
export class NotificationsModule {}
