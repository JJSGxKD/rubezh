import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { LINKS_REPOSITORY, PrismaLinksRepository } from "./links.repository.js";
import { LinksService } from "./links.service.js";
import { RedirectController } from "./redirect.controller.js";
import { RedisShareCardCache, SHARE_CARD_CACHE } from "./share-card.cache.js";
import { ShareController } from "./share.controller.js";
import { ShareService } from "./share.service.js";

/**
 * Редирект-ссылки (docs/35-stage4-plan.md, WP16): `/r/<код>`, клики, ссылки
 * кампаний и шеринг результата забега с карточкой. Ссылку запуска
 * приложения даёт порт площадки `AppLinks`.
 */
@Module({
  imports: [AuthModule, RunsModule],
  controllers: [RedirectController, ShareController],
  providers: [LinksService, ShareService, { provide: LINKS_REPOSITORY, useClass: PrismaLinksRepository }, { provide: SHARE_CARD_CACHE, useClass: RedisShareCardCache }],
  exports: [LinksService],
})
export class LinksModule {}
