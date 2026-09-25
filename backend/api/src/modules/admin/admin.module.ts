import { Module } from "@nestjs/common";
import { AttributionModule } from "../attribution/attribution.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { FunnelModule } from "../funnel/funnel.module.js";
import { MessagingModule } from "../messaging/messaging.module.js";
import { PaymentsModule } from "../payments/payments.module.js";
import { ProgressModule } from "../progress/progress.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { AdminPlayersController } from "./admin-players.controller.js";
import { AdminPlayersService } from "./admin-players.service.js";
import { AdminSessionController } from "./admin-session.controller.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { AdminSessionService } from "./admin-session.service.js";
import { ADMIN_SESSION_STORE, RedisAdminSessionStore } from "./admin-session.store.js";

/**
 * Серверная часть админ-панели (docs/35-stage4-plan.md, WP17;
 * docs/29-admin-panel.md §4): `/api/v1/admin/*` под своей cookie-сессией и
 * гвардом прав. Модуль ничего не хранит сам, кроме сессий: карточка игрока
 * собирается из экспортированных сервисов и репозиториев соседних модулей
 * (docs/36-parallel-work.md §2). Выключен по умолчанию —
 * `ADMIN_PANEL_ENABLED`; выключенный отвечает 404.
 */
@Module({
  imports: [AuthModule, RunsModule, WalletModule, ProgressModule, FunnelModule, AttributionModule, MessagingModule, PaymentsModule],
  controllers: [AdminSessionController, AdminPlayersController],
  providers: [AdminSessionService, AdminSessionGuard, AdminPlayersService, { provide: ADMIN_SESSION_STORE, useClass: RedisAdminSessionStore }],
})
export class AdminModule {}
