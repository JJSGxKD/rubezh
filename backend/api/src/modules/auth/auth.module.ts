import { Module } from "@nestjs/common";
import { ONLINE_ACTIVITY } from "../online/online-activity.js";
import { OnlineCoreModule } from "../online/online-core.module.js";
import { OnlineService } from "../online/online.service.js";
import { AccessRevocations } from "./access-revocations.js";
import { ACCOUNT_REPOSITORY, PrismaAccountRepository } from "./account.repository.js";
import { AuthController } from "./auth.controller.js";
import { AuthHooks } from "./auth-hooks.js";
import { AuthGuard } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";
import { REFRESH_STORE } from "./refresh.store.js";
import { RedisRefreshStore } from "./redis-refresh.store.js";

/**
 * Аккаунты и сессии игроков (docs/34-stage3-plan.md, WP1).
 *
 * Модуль поднимается всегда, а эндпоинты без секрета подписи
 * (`JWT_ACCESS_SECRET`, Р53: ключ задан — включено) отвечают 404: одна
 * сборка на все окружения, а не две разные. Провайдеры при этом ленивые — Prisma открывает
 * соединение на первом запросе, и бэкенд без базы по-прежнему поднимается.
 *
 * `AuthGuard` экспортируется: им закрываются эндпоинты других модулей —
 * забеги и покупки этапа 3. Вместе с ним экспортируется `AccessRevocations`:
 * `@UseGuards(AuthGuard)` Nest собирает в модуле контроллера, а не здесь, и
 * необязательная зависимость гарда без экспорта молча пуста — отзыв токенов
 * тогда действует только на маршрутах самого `AuthController`. С отметкой
 * активности (`ONLINE_ACTIVITY`) то же самое.
 *
 * Порт отметки активности (`ONLINE_ACTIVITY`) — псевдоним сервиса из
 * `OnlineCoreModule`: того же экземпляра счётчика, что отвечает на пинг.
 * `OnlineCoreModule` ничего не импортирует из авторизации, поэтому цикла с
 * `OnlineModule` нет. Без настроек (сборка модуля в тесте руками) сервиса нет,
 * порт пуст, и гард работает как раньше.
 */
@Module({
  imports: [OnlineCoreModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthGuard,
    AuthHooks,
    AccessRevocations,
    { provide: ACCOUNT_REPOSITORY, useClass: PrismaAccountRepository },
    { provide: REFRESH_STORE, useClass: RedisRefreshStore },
    { provide: ONLINE_ACTIVITY, useExisting: OnlineService },
  ],
  // Хуки входа — сессиям и атрибуции: они слушают вход, но в него не вмешиваются.
  exports: [AuthService, AuthGuard, AccessRevocations, AuthHooks, ACCOUNT_REPOSITORY, ONLINE_ACTIVITY],
})
export class AuthModule {}
