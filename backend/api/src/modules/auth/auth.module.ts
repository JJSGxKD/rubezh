import { Module } from "@nestjs/common";
import { ACCOUNT_REPOSITORY, PrismaAccountRepository } from "./account.repository.js";
import { AuthController } from "./auth.controller.js";
import { AuthGuard } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";
import { REFRESH_STORE } from "./refresh.store.js";
import { RedisRefreshStore } from "./redis-refresh.store.js";

/**
 * Аккаунты и сессии игроков (docs/34-stage3-plan.md, WP1).
 *
 * Модуль поднимается всегда, а эндпоинты при `AUTH_ENABLED=false` отвечают
 * 404: выключатель нужен, чтобы закрыть вход без релиза, а не чтобы собирать
 * две разные сборки. Провайдеры при этом ленивые — Prisma открывает
 * соединение на первом запросе, и бэкенд без базы по-прежнему поднимается.
 *
 * `AuthGuard` экспортируется: им закрываются эндпоинты других модулей —
 * забеги и покупки этапа 3.
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthGuard,
    { provide: ACCOUNT_REPOSITORY, useClass: PrismaAccountRepository },
    { provide: REFRESH_STORE, useClass: RedisRefreshStore },
  ],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
