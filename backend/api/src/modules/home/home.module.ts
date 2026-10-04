import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { ChangelogModule } from "../changelog/changelog.module.js";
import { RestrictionsModule } from "../restrictions/restrictions.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { ShopModule } from "../shop/shop.module.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { VipModule } from "../vip/vip.module.js";
import { HomeController } from "./home.controller.js";
import { HomeService } from "./home.service.js";

/**
 * Главная (docs/35-stage4-plan.md WP42): собирает слайды карусели из
 * соседних модулей одним ответом. Своих данных у модуля пока нет —
 * слайды команды из панели придут следующей частью.
 */
@Module({
  imports: [AuthModule, ShopModule, VipModule, ChangelogModule, TasksModule, RestrictionsModule, SettingsModule],
  controllers: [HomeController],
  providers: [HomeService],
})
export class HomeModule {}
