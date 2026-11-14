import { ContentModule } from "../content/content.module.js";
import { ChangeRequestsModule } from "../change-requests/change-requests.module.js";
import { AdminChangeRequestsController } from "./admin-change-requests.controller.js";
import { AdminContentController } from "./admin-content.controller.js";
import { AdminContentPublishController } from "./admin-content-publish.controller.js";
import { LinksModule } from "../links/links.module.js";
import { AdConversionsModule } from "../ad-conversions/ad-conversions.module.js";
import { AdminLinksController } from "./admin-links.controller.js";
import { FlagsModule } from "../flags/flags.module.js";
import { AdminFlagsController } from "./admin-flags.controller.js";
import { BroadcastsModule } from "../broadcasts/broadcasts.module.js";
import { ChangelogModule } from "../changelog/changelog.module.js";
import { PlayerListModule } from "../player-list/player-list.module.js";
import { ShopModule } from "../shop/shop.module.js";
import { BattlePassModule } from "../battle-pass/battle-pass.module.js";
import { TasksModule } from "../tasks/tasks.module.js";
import { AdsModule } from "../ads/ads.module.js";
import { TestNoticeModule } from "../test-notice/test-notice.module.js";
import { AdminChangelogController } from "./admin-changelog.controller.js";
import { AdminShopController } from "./admin-shop.controller.js";
import { AdminHomeController } from "./admin-home.controller.js";
import { HomeModule } from "../home/home.module.js";
import { AdminPromoCodesController } from "./admin-promo-codes.controller.js";
import { PromoCodesModule } from "../promo-codes/promo-codes.module.js";
import { PartnersModule } from "../partners/partners.module.js";
import { AdminCabinetController } from "./admin-cabinet.controller.js";
import { AdminMyProjectController } from "./admin-my-project.controller.js";
import { AdminStakeholdersController } from "./admin-stakeholders.controller.js";
import { AdminLedgerController } from "./admin-ledger.controller.js";
import { LedgerModule } from "../ledger/ledger.module.js";
import { StakeholdersModule } from "../stakeholders/stakeholders.module.js";
import { AdminPartnersController } from "./admin-partners.controller.js";
import { AdminPassController } from "./admin-pass.controller.js";
import { AdminTasksController } from "./admin-tasks.controller.js";
import { AdminCustomerReportController } from "./admin-customer-report.controller.js";
import { CUSTOMER_REPORT_REPOSITORY, PrismaCustomerReportRepository } from "../tasks/customer-report.repository.js";
import { AdminMediaController } from "./admin-media.controller.js";
import { AdminPaymentCompensationController } from "./admin-payment-compensation.controller.js";
import { AdminPaymentJobsController } from "./admin-payment-jobs.controller.js";
import { AdminPaymentReconcileController } from "./admin-payment-reconcile.controller.js";
import { AdminPaymentsController } from "./admin-payments.controller.js";
import { AdminPurchasesController } from "./admin-purchases.controller.js";
import { AdminRestrictionsController } from "./admin-restrictions.controller.js";
import { RestrictionsModule } from "../restrictions/restrictions.module.js";
import { MediaModule } from "../media/media.module.js";
import { AdminAdBlockArchiveController } from "./admin-ad-block-archive.controller.js";
import { AdminAdsController } from "./admin-ads.controller.js";
import { AdminNameRuleCandidatesController } from "./admin-name-rule-candidates.controller.js";
import { AdminNameRulesRecleanController } from "./admin-name-rules-reclean.controller.js";
import { AdminNameRulesController } from "./admin-name-rules.controller.js";
import { AdminNameRulesStatsController } from "./admin-name-rules-stats.controller.js";
import { AdminProxiesController } from "./admin-proxies.controller.js";
import { AdminProxySubscriptionController } from "./admin-proxy-subscription.controller.js";
import { AdminProxyTrafficController } from "./admin-proxy-traffic.controller.js";
import { NameRulesModule } from "../name-rules/name-rules.module.js";
import { AdminBroadcastsController } from "./admin-broadcasts.controller.js";
import { AdminNotifyModule } from "../admin-notify/admin-notify.module.js";
import { AdminAllTimeController } from "./admin-all-time.controller.js";
import { ALL_TIME_STORE, RedisAllTimeStore } from "./admin-all-time.repository.js";
import { AdminAllTimeService } from "./admin-all-time.service.js";
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
import { AdminRequestsController } from "./admin-requests.controller.js";
import { AdminUiClicksController } from "./admin-ui-clicks.controller.js";
import { AdminXrayCoreController } from "./admin-xray-core.controller.js";
import { XrayCoreModule } from "../proxies/xray-core/xray-core.module.js";
import { AdminExportsController } from "./admin-exports.controller.js";
import { AdminExportsService } from "./admin-exports.service.js";
import { AdminFxController } from "./admin-fx.controller.js";
import { AdminPlayersController } from "./admin-players.controller.js";
import { AdminPlayersService } from "./admin-players.service.js";
import { AdminReviewController } from "./admin-review.controller.js";
import { AdminRunsController } from "./admin-runs.controller.js";
import { AdminRunReviewController } from "./admin-run-review.controller.js";
import { AdminRatingController } from "./admin-rating.controller.js";
import { SeasonsModule } from "../seasons/seasons.module.js";
import { AdminRolesController } from "./admin-roles.controller.js";
import { AdminRolesService } from "./admin-roles.service.js";
import { AdminSessionController } from "./admin-session.controller.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { AdminSessionService } from "./admin-session.service.js";
import { ADMIN_SESSION_STORE, RedisAdminSessionStore } from "./admin-session.store.js";
import { PrismaRequestJournalRepository, REQUEST_JOURNAL_READER } from "../request-journal/request-journal.repository.js";
import { RequestJournalService } from "../request-journal/request-journal.service.js";
import { PanelLoginService } from "./panel-login.service.js";
import { PANEL_LOGIN_STORE, RedisPanelLoginStore } from "./panel-login.store.js";
import { RoleConfirmations } from "./role-confirmations.js";
import { BOARD_MARK_READER, PrismaBoardMarkReader } from "./board-mark.reader.js";
import { AdminPulseController } from "./admin-pulse.controller.js";
import { AdminPulseService } from "./admin-pulse.service.js";
import { OnlineCoreModule } from "../online/online-core.module.js";
import { CSP_REPORTS_REPOSITORY, RedisCspReportsRepository } from "../csp-reports/csp-reports.repository.js";
import { CspReportsService } from "../csp-reports/csp-reports.service.js";

/**
 * Серверная часть админ-панели (docs/35-stage4-plan.md, WP17;
 * docs/29-admin-panel.md §4): `/api/v1/admin/*` под своей cookie-сессией и
 * гвардом прав. Модуль ничего не хранит сам, кроме сессий: карточка игрока,
 * курсы, роли, отчёты и выгрузки — экспортированные сервисы и репозитории
 * соседних модулей (docs/36-parallel-work.md §2). Работает вместе со входом
 * (`JWT_ACCESS_SECRET`, Р53); без входа отвечает 404.
 */
@Module({
  imports: [AuthModule, RunsModule, WalletModule, ProgressModule, FunnelModule, AttributionModule, MessagingModule, NotificationsModule, PaymentsModule, FxModule, DiagnosticsModule, ExportModule, FriendsModule, ReferralsModule, LinksModule, FlagsModule, BroadcastsModule, ChangelogModule, PlayerListModule, TasksModule, BattlePassModule, MediaModule, RestrictionsModule, TestNoticeModule, AdsModule, ShopModule, PromoCodesModule, PartnersModule, StakeholdersModule, LedgerModule, AdminNotifyModule, AdConversionsModule, HomeModule, NameRulesModule, SeasonsModule, ContentModule, ChangeRequestsModule, OnlineCoreModule, XrayCoreModule],
  controllers: [
    AdminSessionController,
    AdminPlayersController,
    AdminReviewController,
    AdminRunsController,
    AdminRunReviewController,
    AdminRatingController,
    AdminOverviewController,
    AdminAllTimeController,
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
    AdminHomeController,
    AdminTasksController,
    AdminCustomerReportController,
    AdminPassController,
    AdminMediaController,
    AdminRestrictionsController,
    AdminPurchasesController,
    AdminPaymentsController,
    AdminPaymentCompensationController,
    AdminPaymentJobsController,
    AdminPaymentReconcileController,
    AdminAdsController,
    AdminAdBlockArchiveController,
    AdminNameRulesController,
    AdminNameRulesStatsController,
    AdminNameRuleCandidatesController,
    AdminProxiesController,
    AdminProxySubscriptionController,
    AdminProxyTrafficController,
    AdminXrayCoreController,
    AdminNameRulesRecleanController,
    AdminShopController,
    AdminPromoCodesController,
    AdminPartnersController,
    AdminCabinetController,
    AdminStakeholdersController,
    AdminMyProjectController,
    AdminLedgerController,
    AdminRequestsController,
    AdminUiClicksController,
    AdminContentController,
    AdminContentPublishController,
    AdminChangeRequestsController,
    AdminPulseController,
  ],
  providers: [
    AdminSessionService,
    AdminSessionGuard,
    AdminPlayersService,
    AdminRolesService,
    AdminOverviewService,
    // Итоги за всё время (T-0203): репозиторий — в `AdminNotifyModule`, его же читает ночное задание снимка
    AdminAllTimeService,
    { provide: ALL_TIME_STORE, useClass: RedisAllTimeStore },
    AdminExportsService,
    // Отчёт заказчику партнёрских заданий (T-0225): читает только панель
    { provide: CUSTOMER_REPORT_REPOSITORY, useClass: PrismaCustomerReportRepository },
    AdminSocialService,
    AdminSettingsService,
    AdminSecretsService,
    { provide: ADMIN_SESSION_STORE, useClass: RedisAdminSessionStore },
    PanelLoginService,
    { provide: PANEL_LOGIN_STORE, useClass: RedisPanelLoginStore },
    RoleConfirmations,
    // Метку «Отдельная доска» читают только отчёты панели (T-0115)
    { provide: BOARD_MARK_READER, useClass: PrismaBoardMarkReader },
    // Журнал запросов читает только панель; запись — в глобальном `RequestJournalModule`
    { provide: REQUEST_JOURNAL_READER, useClass: PrismaRequestJournalRepository },
    RequestJournalService,
    // Пульс в шапке (T-0360) только читает сводку блокировок клиента: `CspReportsModule`
    // импортирует `AdminModule` ради гарда, поэтому сервис здесь свой, а не из того модуля
    { provide: CSP_REPORTS_REPOSITORY, useClass: RedisCspReportsRepository },
    CspReportsService,
    AdminPulseService,
  ],
  // Гард панели закрывает маршруты модулей, у которых контроллер вне `AdminModule`.
  // Он экспортируется вместе с сервисом сессий: `@UseGuards(...)` Nest собирает в
  // модуле контроллера, а не здесь (то же, что у `AuthGuard` в `auth.module.ts`).
  exports: [PanelLoginService, RoleConfirmations, AdminSessionGuard, AdminSessionService],
})
export class AdminModule {}
