import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { EventsModule } from "../events/events.module.js";
import { EXTERNAL_IDENTITY_REPOSITORY, PrismaExternalIdentityRepository } from "./external-identity.repository.js";
import { ExternalIdentityService } from "./external-identity.service.js";
import { LINK_CODE_STORE, RedisLinkCodes } from "./link-codes.js";

/**
 * Связь игрового аккаунта с аккаунтом MAX или VK (docs/35-stage4-plan.md Р188,
 * tasks/T-0377): одноразовые коды в Redis, пары «площадка + id» в базе.
 * Сервис экспортируется заданиям и ботам площадок. Порт `ExternalLinkStarters`
 * здесь не собирается: ссылки на ботов собирает `platforms/platforms.module.ts`
 * (глобальный модуль), потому что только там можно знать адаптеры площадок —
 * модули домена их не импортируют.
 */
@Module({
  imports: [AuthModule, EventsModule],
  providers: [
    ExternalIdentityService,
    { provide: EXTERNAL_IDENTITY_REPOSITORY, useClass: PrismaExternalIdentityRepository },
    { provide: LINK_CODE_STORE, useClass: RedisLinkCodes },
  ],
  exports: [ExternalIdentityService],
})
export class ExternalIdentityModule {}
