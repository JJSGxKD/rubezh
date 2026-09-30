import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { ChangelogModule } from "../changelog/changelog.module.js";
import { DailyModule } from "../daily/daily.module.js";
import { FriendsModule } from "../friends/friends.module.js";
import { ItemsModule } from "../items/items.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { BadgesController } from "./badges.controller.js";
import { BadgesService } from "./badges.service.js";

/**
 * Знаки меню (docs/35-stage4-plan.md Р50): собирает счётчики соседних
 * модулей одним ответом. Своих данных у модуля нет.
 */
@Module({
  imports: [AuthModule, ItemsModule, FriendsModule, NotificationsModule, DailyModule, ChangelogModule],
  controllers: [BadgesController],
  providers: [BadgesService],
})
export class BadgesModule {}
