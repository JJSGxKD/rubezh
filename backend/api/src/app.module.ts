import { Module } from "@nestjs/common";
import { AppConfigModule } from "./config/config.module.js";
import { PlatformsModule } from "./platforms/platforms.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { RolesModule } from "./modules/roles/roles.module.js";
import { RunsModule } from "./modules/runs/runs.module.js";
import { DatabaseModule } from "./infra/database.js";
import { RedisModule } from "./infra/redis.js";
import { AdminNotifyModule } from "./modules/admin-notify/admin-notify.module.js";
import { BotModule } from "./platforms/telegram/bot.module.js";
import { DiagnosticsModule } from "./modules/diagnostics/diagnostics.module.js";
import { FeedbackModule } from "./modules/feedback/feedback.module.js";
import { EventsModule } from "./modules/events/events.module.js";
import { ExportModule } from "./modules/export/export.module.js";
import { IngestModule } from "./modules/ingest/ingest.module.js";
import { TelegramModule } from "./platforms/telegram/telegram.module.js";
import { WelcomeModule } from "./platforms/telegram/welcome.module.js";
import { PaymentsModule } from "./modules/payments/payments.module.js";
import { TelegramPaymentsModule } from "./platforms/telegram/telegram-payments.module.js";
import { AttributionModule } from "./modules/attribution/attribution.module.js";
import { FunnelModule } from "./modules/funnel/funnel.module.js";
import { MessagingModule } from "./modules/messaging/messaging.module.js";
import { WalletModule } from "./modules/wallet/wallet.module.js";
import { FxModule } from "./modules/fx/fx.module.js";
import { ProgressModule } from "./modules/progress/progress.module.js";
import { ItemsModule } from "./modules/items/items.module.js";
import { BoostsModule } from "./modules/boosts/boosts.module.js";
import { TelegramMessagingModule } from "./platforms/telegram/telegram-messaging.module.js";
import { HealthController } from "./health/health.controller.js";
import { AdminModule } from "./modules/admin/admin.module.js";
import { FriendsModule } from "./modules/friends/friends.module.js";
import { ReferralsModule } from "./modules/referrals/referrals.module.js";
import { LinksModule } from "./modules/links/links.module.js";
import { FlagsModule } from "./modules/flags/flags.module.js";
import { BroadcastsModule } from "./modules/broadcasts/broadcasts.module.js";
import { SettingsModule } from "./modules/settings/settings.module.js";
import { SecretsModule } from "./modules/secrets/secrets.module.js";
import { AdConversionsModule } from "./modules/ad-conversions/ad-conversions.module.js";
import { TelegramPanelLoginModule } from "./platforms/telegram/telegram-panel-login.module.js";
import { AccountSettingsModule } from "./modules/account-settings/account-settings.module.js";
import { NotificationsModule } from "./modules/notifications/notifications.module.js";
import { NotificationsBotModule } from "./modules/notifications-bot/notifications-bot.module.js";
import { BadgesModule } from "./modules/badges/badges.module.js";
import { HistoryModule } from "./modules/history/history.module.js";
import { DailyModule } from "./modules/daily/daily.module.js";
import { ChangelogModule } from "./modules/changelog/changelog.module.js";
import { WheelModule } from "./modules/wheel/wheel.module.js";
import { TasksModule } from "./modules/tasks/tasks.module.js";
import { MediaModule } from "./modules/media/media.module.js";
import { RestrictionsModule } from "./modules/restrictions/restrictions.module.js";
import { TestNoticeModule } from "./modules/test-notice/test-notice.module.js";
import { AdsModule } from "./modules/ads/ads.module.js";
import { ShopModule } from "./modules/shop/shop.module.js";
import { VipModule } from "./modules/vip/vip.module.js";
import { PromoCodesModule } from "./modules/promo-codes/promo-codes.module.js";
import { PartnersModule } from "./modules/partners/partners.module.js";

/**
 * Модули по плану из docs/01-tech-stack.md §3: auth, runs, leaderboard,
 * payments, economy. Добавляются по мере реализации в роадмапе
 * (docs/02-roadmap.md).
 *
 * auth — аккаунты и сессии игроков (docs/34-stage3-plan.md, WP1);
 * roles — права, роли и журнал аудита (там же, WP2);
 * runs — забеги под аккаунтом и рейтинг на них (там же, WP4);
 * payments — второй шанс за Telegram Stars (там же, WP5);
 * attribution — сессии, первое и последнее касание (там же, WP6);
 * funnel — вехи воронки аккаунта, messaging — можно ли писать игроку
 * (docs/35-stage4-plan.md, WP2); wallet — кошелёк журналом (там же, WP3);
 * fx — курсы валют вокруг ядра packages/fx (там же, WP9); progress — уровень
 * аккаунта и награды за забег (там же, WP4); items — снаряжение и добыча
 * (там же, WP7); boosts — бусты на забег (там же, WP8); admin — серверная часть панели
 * под своей cookie-сессией (там же, WP17), выключена по умолчанию; settings —
 * настройки без релиза: база поверх окружения (там же, WP24); account-settings
 * — настройки игрока, общие для его устройств (там же, WP29); notifications —
 * лента уведомлений игрока, в которую пишут доменные модули, badges — знаки
 * меню одним ответом (там же, WP28); changelog — журнал обновлений по
 * площадкам и уведомление о выходе версии (там же, WP31); promo-codes —
 * промокоды: ввод игроком и кампании в панели, partners — партнёры и
 * приведённые ими игроки (там же, WP41).
 *
 * platforms — адаптеры площадок за портами (docs/35-stage4-plan.md, §3.11).
 */
export const APP_MODULES = [
  RedisModule,
  DatabaseModule,
  SettingsModule,
  SecretsModule,
  AdConversionsModule,
  PlatformsModule,
  IngestModule,
  TelegramModule,
  RolesModule,
  AuthModule,
  AccountSettingsModule,
  NotificationsModule,
  NotificationsBotModule,
  AttributionModule,
  FunnelModule,
  MessagingModule,
  TelegramMessagingModule,
  RunsModule,
  WalletModule,
  ItemsModule,
  BoostsModule,
  ProgressModule,
  FxModule,
  PaymentsModule,
  TelegramPaymentsModule,
  BotModule,
  EventsModule,
  DiagnosticsModule,
  FeedbackModule,
  AdminNotifyModule,
  ExportModule,
  WelcomeModule,
  AdminModule,
  TelegramPanelLoginModule,
  FriendsModule,
  BadgesModule,
  HistoryModule,
  DailyModule,
  ReferralsModule,
  LinksModule,
  FlagsModule,
  BroadcastsModule,
  ChangelogModule,
  WheelModule,
  MediaModule,
  RestrictionsModule,
  TasksModule,
  TestNoticeModule,
  AdsModule,
  ShopModule,
  VipModule,
  PromoCodesModule,
  PartnersModule,
];

/**
 * Приложение — это модули выше и конфигурация из окружения. Список вынесен,
 * чтобы тест старта собирал то же приложение со своей конфигурацией, не
 * читая `.env` разработчика (`test/app-boot.integration.test.ts`).
 */
@Module({
  imports: [AppConfigModule, ...APP_MODULES],
  controllers: [HealthController],
})
export class AppModule {}
