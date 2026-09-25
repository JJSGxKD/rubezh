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
import { TelegramMessagingModule } from "./platforms/telegram/telegram-messaging.module.js";
import { HealthController } from "./health/health.controller.js";
import { PlaytestModule } from "./modules/playtest/playtest.module.js";
import { AdminModule } from "./modules/admin/admin.module.js";
import { FriendsModule } from "./modules/friends/friends.module.js";
import { ReferralsModule } from "./modules/referrals/referrals.module.js";
import { LinksModule } from "./modules/links/links.module.js";

/**
 * Модули по плану из docs/01-tech-stack.md §3: auth, runs, leaderboard,
 * payments, economy. Добавляются по мере реализации в роадмапе
 * (docs/02-roadmap.md).
 *
 * playtest — сводка закрытого теста, отчёты о запуске и доступ к
 * инструментам, выключен по умолчанию (docs/26-stage2-plan.md, WP14). Забеги
 * и рейтинг из него переехали в runs.
 *
 * auth — аккаунты и сессии игроков (docs/34-stage3-plan.md, WP1);
 * roles — права, роли и журнал аудита (там же, WP2);
 * runs — забеги под аккаунтом и рейтинг на них (там же, WP4);
 * payments — второй шанс за Telegram Stars (там же, WP5);
 * attribution — сессии, первое и последнее касание (там же, WP6);
 * funnel — вехи воронки аккаунта, messaging — можно ли писать игроку
 * (docs/35-stage4-plan.md, WP2); wallet — кошелёк журналом (там же, WP3);
 * fx — курсы валют вокруг ядра packages/fx (там же, WP9); progress — уровень
 * аккаунта и награды за забег (там же, WP4); admin — серверная часть панели
 * под своей cookie-сессией (там же, WP17), выключена по умолчанию.
 *
 * platforms — адаптеры площадок за портами (docs/35-stage4-plan.md, §3.11).
 */
export const APP_MODULES = [
  RedisModule,
  DatabaseModule,
  PlatformsModule,
  IngestModule,
  TelegramModule,
  RolesModule,
  AuthModule,
  AttributionModule,
  FunnelModule,
  MessagingModule,
  TelegramMessagingModule,
  RunsModule,
  WalletModule,
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
  PlaytestModule,
  AdminModule,
  FriendsModule,
  ReferralsModule,
  LinksModule,
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
