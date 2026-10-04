import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { ChangelogModule } from "../changelog/changelog.module.js";
import { MediaModule } from "../media/media.module.js";
import { RestrictionsModule } from "../restrictions/restrictions.module.js";
import { SettingsModule } from "../settings/settings.module.js";
import { ShopModule } from "../shop/shop.module.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { VipModule } from "../vip/vip.module.js";
import { HomeController } from "./home.controller.js";
import { HomeService } from "./home.service.js";
import { PrismaTeamSlideRepository, TEAM_SLIDE_REPOSITORY } from "./team-slide.repository.js";
import { TeamSlidesService } from "./team-slides.service.js";

/**
 * Главная (docs/35-stage4-plan.md WP42): собирает слайды карусели из
 * соседних модулей одним ответом. Свои данные модуля — слайды команды из
 * панели (`home_slide`): их правит раздел «Главная» через `TeamSlidesService`.
 */
@Module({
  imports: [AuthModule, ShopModule, VipModule, ChangelogModule, TasksModule, RestrictionsModule, SettingsModule, MediaModule],
  controllers: [HomeController],
  providers: [HomeService, TeamSlidesService, { provide: TEAM_SLIDE_REPOSITORY, useClass: PrismaTeamSlideRepository }],
  exports: [TeamSlidesService],
})
export class HomeModule {}
