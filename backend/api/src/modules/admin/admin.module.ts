import { Module } from "@nestjs/common";
import { AttributionModule } from "../attribution/attribution.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { FunnelModule } from "../funnel/funnel.module.js";
import { FxModule } from "../fx/fx.module.js";
import { MessagingModule } from "../messaging/messaging.module.js";
import { PaymentsModule } from "../payments/payments.module.js";
import { ProgressModule } from "../progress/progress.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
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

/**
 * Серверная часть админ-панели (docs/35-stage4-plan.md, WP17;
 * docs/29-admin-panel.md §4): `/api/v1/admin/*` под своей cookie-сессией и
 * гвардом прав. Модуль ничего не хранит сам, кроме сессий: карточка игрока,
 * курсы и роли — экспортированные сервисы и репозитории соседних модулей
 * (docs/36-parallel-work.md §2). Выключен по умолчанию —
 * `ADMIN_PANEL_ENABLED`; выключенный отвечает 404.
 */
@Module({
  imports: [AuthModule, RunsModule, WalletModule, ProgressModule, FunnelModule, AttributionModule, MessagingModule, PaymentsModule, FxModule],
  controllers: [AdminSessionController, AdminPlayersController, AdminReviewController, AdminFxController, AdminRolesController],
  providers: [AdminSessionService, AdminSessionGuard, AdminPlayersService, AdminRolesService, { provide: ADMIN_SESSION_STORE, useClass: RedisAdminSessionStore }],
})
export class AdminModule {}
