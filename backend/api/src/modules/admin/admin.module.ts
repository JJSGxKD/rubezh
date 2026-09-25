import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { AdminSessionController } from "./admin-session.controller.js";
import { AdminSessionGuard } from "./admin-session.guard.js";
import { AdminSessionService } from "./admin-session.service.js";
import { ADMIN_SESSION_STORE, RedisAdminSessionStore } from "./admin-session.store.js";

/**
 * Серверная часть админ-панели (docs/35-stage4-plan.md, WP17;
 * docs/29-admin-panel.md §4): `/api/v1/admin/*` под своей cookie-сессией и
 * гвардом прав. Выключен по умолчанию — `ADMIN_PANEL_ENABLED`; выключенный
 * отвечает 404.
 */
@Module({
  imports: [AuthModule],
  controllers: [AdminSessionController],
  providers: [AdminSessionService, AdminSessionGuard, { provide: ADMIN_SESSION_STORE, useClass: RedisAdminSessionStore }],
})
export class AdminModule {}
