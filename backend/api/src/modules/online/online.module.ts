import { Module } from "@nestjs/common";
import { AdminSessionGuard } from "../admin/admin-session.guard.js";
import { AdminSessionService } from "../admin/admin-session.service.js";
import { ADMIN_SESSION_STORE, RedisAdminSessionStore } from "../admin/admin-session.store.js";
import { AuthModule } from "../auth/auth.module.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { OnlineAdminController, OnlineController } from "./online.controller.js";
import { OnlineJob } from "./online.job.js";
import { ONLINE_REPOSITORY, RedisOnlineRepository } from "./online.repository.js";
import { OnlineService } from "./online.service.js";

/**
 * Счётчик онлайна (Р107, docs/35-stage4-plan.md): пинг игрока, снимок для
 * панели и пересчёт раз в 15 с.
 *
 * Отметку активности ставит `AuthGuard` через порт `ONLINE_ACTIVITY` — его
 * даёт `AuthModule`, чтобы авторизация не импортировала этот модуль (цикл).
 *
 * Гард панели собирается здесь сам: `AdminModule` его не экспортирует, а
 * правка чужого модуля ради одного маршрута хуже второго экземпляра
 * сервиса без собственного состояния.
 */
@Module({
  imports: [AuthModule],
  controllers: [OnlineController, OnlineAdminController],
  providers: [
    OnlineService,
    OnlineJob,
    RateLimiter,
    AdminSessionService,
    AdminSessionGuard,
    { provide: ONLINE_REPOSITORY, useClass: RedisOnlineRepository },
    { provide: ADMIN_SESSION_STORE, useClass: RedisAdminSessionStore },
  ],
})
export class OnlineModule {}
