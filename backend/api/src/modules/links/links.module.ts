import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { AUTO_SOURCES_REPOSITORY, PrismaAutoSourcesRepository } from "./auto-sources.repository.js";
import { AutoSourcesService } from "./auto-sources.service.js";
import { LINKS_REPOSITORY, PrismaLinksRepository } from "./links.repository.js";
import { LinksService } from "./links.service.js";
import { RedirectController } from "./redirect.controller.js";

/**
 * Редирект-ссылки (docs/35-stage4-plan.md, WP16): `/r/<код>`, клики, ссылки
 * кампаний. Ссылку запуска приложения даёт порт площадки `AppLinks`.
 *
 * Автоисточники по ссылкам с метками (Р116) заводит `AutoSourcesService`; его зовёт запись
 * сессий (`AttributionModule`), поэтому он в `exports`: параметр рекордера необязателен,
 * и без экспорта провайдер молча пропал бы. Модуль атрибуции `LinksModule` не импортирует —
 * цикла нет.
 */
@Module({
  imports: [AuthModule],
  controllers: [RedirectController],
  providers: [
    LinksService,
    { provide: LINKS_REPOSITORY, useClass: PrismaLinksRepository },
    AutoSourcesService,
    { provide: AUTO_SOURCES_REPOSITORY, useClass: PrismaAutoSourcesRepository },
  ],
  exports: [LinksService, AutoSourcesService],
})
export class LinksModule {}
