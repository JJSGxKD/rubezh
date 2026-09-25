import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { LINKS_REPOSITORY, PrismaLinksRepository } from "./links.repository.js";
import { LinksService } from "./links.service.js";
import { RedirectController } from "./redirect.controller.js";

/**
 * Редирект-ссылки (docs/35-stage4-plan.md, WP16): `/r/<код>`, клики, ссылки
 * кампаний. Ссылку запуска приложения даёт порт площадки `AppLinks`.
 */
@Module({
  imports: [AuthModule],
  controllers: [RedirectController],
  providers: [LinksService, { provide: LINKS_REPOSITORY, useClass: PrismaLinksRepository }],
  exports: [LinksService],
})
export class LinksModule {}
