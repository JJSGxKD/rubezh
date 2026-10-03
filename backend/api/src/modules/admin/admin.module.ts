import { LinksModule } from "../links/links.module.js";
import { AdConversionsModule } from "../ad-conversions/ad-conversions.module.js";
import { AdminLinksController } from "./admin-links.controller.js";
import { FlagsModule } from "../flags/flags.module.js";
import { AdminFlagsController } from "./admin-flags.controller.js";
import { BroadcastsModule } from "../broadcasts/broadcasts.module.js";
import { ChangelogModule } from "../changelog/changelog.module.js";
import { PlayerListModule } from "../player-list/player-list.module.js";
import { ShopModule } from "../shop/shop.module.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { AdsModule } from "../ads/ads.module.js";
import { TestNoticeModule } from "../test-notice/test-notice.module.js";
import { AdminChangelogController } from "./admin-changelog.controller.js";
import { AdminShopController } from "./admin-shop.controller.js";
import { AdminPromoCodesController } from "./admin-promo-codes.controller.js";
import { PromoCodesModule } from "../promo-codes/promo-codes.module.js";
import { PartnersModule } from "../partners/partners.module.js";
import { AdminPartnersController } from "./admin-partners.controller.js";
import { AdminTasksController } from "./admin-tasks.controller.js";
import { AdminMediaController } from "./admin-media.controller.js";
import { AdminRestrictionsController } from "./admin-restrictions.controller.js";
import { RestrictionsModule } from "../restrictions/restrictions.module.js";
import { MediaModule } from "../media/media.module.js";
import { AdminAdsController } from "./admin-ads.controller.js";
import { AdminBroadcastsController } from "./admin-broadcasts.controller.js";
import { AdminNotifyModule } from "../admin-notify/admin-notify.module.js";
import { AdminOverviewController } from "./admin-overview.controller.js";
import { AdminOverviewService } from "./admin-overview.service.js";
import { FriendsModule } from "../friends/friends.module.js";
import { ReferralsModule } from "../referrals/referrals.module.js";
import { AdminSocialController } from "./admin-social.controller.js";
import { AdminSocialService } from "./admin-social.service.js";
import { AdminSecretsController } from "./admin-secrets.controller.js";
import { AdminSecretsService } from "./admin-secrets.service.js";
import { AdminSettingsController } from "./admin-settings.controller.js";
import { AdminSettingsService } from "./admin-settings.service.js";
import { Module } from "@nestjs/common";
import { AttributionModule } from "../attribution/attribution.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { DiagnosticsModule } from "../diagnostics/diagnostics.module.js";
import { ExportModule } from "../export/export.module.js";
import { FunnelModule } from "../funnel/funnel.module.js";
import { FxModule } from "../fx/fx.module.js";
import { MessagingModule } from "../messaging/messaging.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { PaymentsModule } from "../payments/payments.module.js";
import { ProgressModule } from "../progress/progress.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { AdminDiagnosticsController } from "./admin-diagnostics.controller.js";
import { AdminExportsController } from "./admin-exports.controller.js";
import { AdminExportsService } from "./admin-exports.service.js";
import { AdminFxController } from "./admin-fx.controller.js";
import { AdminPlayersController } from "./admin-players.controller.js";
import { AdminPlayersService } from "./admin-players.service.js";
import { AdminReviewController } from "./admin-review.controller.js";
import { AdminRolesController } from "./admin-roles.controller.js";
import { AdminRolesService } from "./admin-roles.service.js";
import { AdminSessionController } from "./admin-session.controller.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { AdminSessionService } from "./admin-session.service.js";
import { ADMIN_SESSION_STORE, RedisAdminSessionStore } from "./admin-session.store.js";
import { PanelLoginService } from "./panel-login.service.js";
import { PANEL_LOGIN_STORE, RedisPanelLoginStore } from "./panel-login.store.js";

/**
 * Серверная часть админ-панели (docs/35-stage4-plan.md, WP17;
 * docs/29-admin-panel.md §4): `/api/v1/admin/*` под своей cookie-сессией и
 * гвардом прав. Модуль ничего не хранит сам, кроме сессий: карточка игрока,
 * курсы, роли, отчёты и выгрузки — экспортированные сервисы и репозитории
 * соседних модулей (docs/36-parallel-work.md §2). Работает вместе со входом
 * (`JWT_ACCESS_SECRET`, Р53); без входа отвечает 404.
 */
@Module({
  imports: [AuthModule, RunsModule, WalletModule, ProgressModule, FunnelModule, AttributionModule, MessagingModule, NotificationsModule, PaymentsModule, FxModule, DiagnosticsModule, ExportModule, FriendsModule, ReferralsModule, LinksModule, FlagsModule, BroadcastsModule, ChangelogModule, PlayerListModule, TasksModule, MediaModule, RestrictionsModule, TestNoticeModule, AdsModule, ShopModule, PromoCodesModule, PartnersModule, AdminNotifyModule, AdConversionsModule],
  controllers: [
    AdminSessionController,
    AdminPlayersController,
    AdminReviewController,
    AdminOverviewController,
    AdminFxController,
    AdminRolesController,
    AdminDiagnosticsController,
    AdminExportsController,
    AdminSocialController,
    AdminLinksController,
    AdminFlagsController,
    AdminSettingsController,
    AdminSecretsController,
    AdminBroadcastsController,
    AdminChangelogController,
    AdminTasksController,
    AdminMediaController,
    AdminRestrictionsController,
    AdminAdsController,
    AdminShopController,
    AdminPromoCodesController,
    AdminPartnersController,
  ],
  providers: [
    AdminSessionService,
    AdminSessionGuard,
    AdminPlayersService,
    AdminRolesService,
    AdminOverviewService,
    AdminExportsService,
    AdminSocialService,
    AdminSettingsService,
    AdminSecretsService,
    { provide: ADMIN_SESSION_STORE, useClass: RedisAdminSessionStore },
    PanelLoginService,
    { provide: PANEL_LOGIN_STORE, useClass: RedisPanelLoginStore },
  ],
  exports: [PanelLoginService],
})
export class AdminModule {}
