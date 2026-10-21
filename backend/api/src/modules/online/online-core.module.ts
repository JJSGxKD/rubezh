import { Module } from "@nestjs/common";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { ONLINE_REPOSITORY, RedisOnlineRepository, type OnlineRepository } from "./online.repository.js";
import { OnlineService } from "./online.service.js";

/**
 * Единственный экземпляр счётчика онлайна на приложение (Р107).
 *
 * Его берут два потребителя: `AuthModule` — отметка активности в `AuthGuard`
 * (порт `ONLINE_ACTIVITY` он собирает сам поверх этого сервиса: Nest не даёт
 * реэкспортировать токен импортированного модуля), и `OnlineModule` — пинг и пересчёт. Один
 * экземпляр нужен, чтобы состояние сервиса (не чаще одной строки `warn` в
 * минуту) и хранилище не двоились.
 *
 * Модуль ничего не импортирует из `auth` и `admin`: `REDIS` и `SETTINGS_READER`
 * приходят из глобальных модулей. Поэтому `AuthModule` может подключить его без
 * цикла с `OnlineModule`, который сам импортирует `AuthModule`.
 *
 * Без настроек (модуль авторизации собран в тесте руками) сервис не создаётся,
 * порт отметки активности пуст, и `AuthGuard` работает без счётчика.
 */
@Module({
  providers: [
    { provide: ONLINE_REPOSITORY, useClass: RedisOnlineRepository },
    {
      provide: OnlineService,
      inject: [ONLINE_REPOSITORY, { token: SETTINGS_READER, optional: true }],
      useFactory: (repository: OnlineRepository, settings: SettingsReader | undefined): OnlineService | undefined =>
        settings === undefined ? undefined : new OnlineService(repository, settings),
    },
  ],
  exports: [ONLINE_REPOSITORY, OnlineService],
})
export class OnlineCoreModule {}
