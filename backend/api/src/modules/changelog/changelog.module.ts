import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { ChangelogFanout } from "./changelog-fanout.js";
import { ChangelogController } from "./changelog.controller.js";
import { CHANGELOG_REPOSITORY, PrismaChangelogRepository } from "./changelog.repository.js";
import { ChangelogService } from "./changelog.service.js";

/**
 * Журнал обновлений (docs/35-stage4-plan.md Р61, WP31): игроку — строки его
 * площадки по версиям, панели — правка и публикация, выход версии —
 * уведомление `app_update` каждому через ленту.
 */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [ChangelogController],
  providers: [ChangelogService, ChangelogFanout, { provide: CHANGELOG_REPOSITORY, useClass: PrismaChangelogRepository }],
  exports: [ChangelogService],
})
export class ChangelogModule {}
