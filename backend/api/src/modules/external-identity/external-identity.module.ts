import { Module } from "@nestjs/common";
import { ExternalLinkStarters } from "../../platforms/ports/external-link.js";
import { AuthModule } from "../auth/auth.module.js";
import { EventsModule } from "../events/events.module.js";
import { EXTERNAL_IDENTITY_REPOSITORY, PrismaExternalIdentityRepository } from "./external-identity.repository.js";
import { ExternalIdentityService } from "./external-identity.service.js";
import { LINK_CODE_STORE, RedisLinkCodes } from "./link-codes.js";

/**
 * Стартеры ботов площадок (docs/35-stage4-plan.md Р188). Список начинается
 * пустым: адаптер площадки сам подключает себя при старте своего модуля
 * (`ExternalLinkStarters.register`), так что домен адаптеров не импортирует.
 * Пока площадка не подключена, её каналы не видны игрокам других площадок.
 */
export function externalLinkStartersFor(): ExternalLinkStarters {
  return new ExternalLinkStarters([]);
}

/**
 * Связь игрового аккаунта с аккаунтом MAX или VK (docs/35-stage4-plan.md Р188,
 * tasks/T-0377): одноразовые коды в Redis, пары «площадка + id» в базе.
 * Сервис экспортируется заданиям и ботам площадок; модули домена видят только
 * порт `ExternalLinkStarters`, а не адаптеры.
 */
@Module({
  imports: [AuthModule, EventsModule],
  providers: [
    ExternalIdentityService,
    { provide: ExternalLinkStarters, useFactory: externalLinkStartersFor },
    { provide: EXTERNAL_IDENTITY_REPOSITORY, useClass: PrismaExternalIdentityRepository },
    { provide: LINK_CODE_STORE, useClass: RedisLinkCodes },
  ],
  exports: [ExternalIdentityService, ExternalLinkStarters],
})
export class ExternalIdentityModule {}
