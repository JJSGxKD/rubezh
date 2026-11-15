import { Module } from "@nestjs/common";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../../config/app-config.js";
import { Outbound } from "../../../infra/outbound/outbound.js";
import { REDIS } from "../../../infra/redis.js";
import { RolesService } from "../../roles/roles.service.js";
import { SECRETS_READER, type SecretsReader } from "../../secrets/secrets.service.js";
import { XrayReleases } from "./xray-core-releases.js";
import { XrayCoreUpdater } from "./xray-core-update.js";
import { XrayCoreService } from "./xray-core.service.js";

/**
 * «Ядро Xray» (docs/35-stage4-plan.md Р202, tasks/T-0416): версия запущенного
 * ядра, свежий выпуск, совместимость и запуск обновления. Клиент исходящих,
 * Redis, ключи интеграций и роли — глобальные модули, импортировать их не нужно.
 * Контроллер панели живёт в `AdminModule`.
 *
 * Все запросы к GitHub идут под одной меткой исходящих `github.api`.
 */
@Module({
  providers: [
    {
      provide: XrayReleases,
      inject: [REDIS, Outbound],
      useFactory: (redis: Redis, outbound: Outbound): XrayReleases => new XrayReleases({ redis, fetch: outbound.forService("github.api") }),
    },
    {
      provide: XrayCoreUpdater,
      inject: [REDIS, Outbound],
      useFactory: (redis: Redis, outbound: Outbound): XrayCoreUpdater => new XrayCoreUpdater({ redis, fetch: outbound.forService("github.api") }),
    },
    {
      provide: XrayCoreService,
      inject: [RolesService, SECRETS_READER, XrayReleases, XrayCoreUpdater, APP_CONFIG],
      useFactory: (roles: RolesService, secrets: SecretsReader, releases: XrayReleases, updater: XrayCoreUpdater, config: AppConfig): XrayCoreService =>
        new XrayCoreService({ roles, secrets, releases, updater, statusPath: config.xray.statusPath }),
    },
  ],
  exports: [XrayCoreService],
})
export class XrayCoreModule {}
