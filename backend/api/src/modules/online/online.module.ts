import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { OnlineCoreModule } from "./online-core.module.js";
import { OnlineAdminController, OnlineController } from "./online.controller.js";
import { OnlineJob } from "./online.job.js";

/**
 * Счётчик онлайна (Р107, docs/35-stage4-plan.md): пинг игрока, снимок для
 * панели и пересчёт раз в 15 с.
 *
 * Сервис счётчика приходит из `OnlineCoreModule`: он один на приложение, и им же
 * `AuthGuard` отмечает активность через порт `ONLINE_ACTIVITY`. Гард панели
 * приходит из `AdminModule`, который экспортирует его для таких модулей.
 */
@Module({
  imports: [AuthModule, AdminModule, OnlineCoreModule],
  controllers: [OnlineController, OnlineAdminController],
  providers: [OnlineJob, RateLimiter],
})
export class OnlineModule {}
