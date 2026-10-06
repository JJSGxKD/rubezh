import { Module } from "@nestjs/common";
import { PARTNERS_REPOSITORY, PrismaPartnersRepository } from "./partners.repository.js";
import { PartnersService } from "./partners.service.js";

/**
 * Партнёры (docs/35-stage4-plan.md WP41, часть 2): кто приводит игроков
 * своими промокодами. Привязку пишет модуль промокодов при активации кода
 * партнёра; этот модуль — карточки партнёров и их статистика для панели.
 */
@Module({
  providers: [PartnersService, { provide: PARTNERS_REPOSITORY, useClass: PrismaPartnersRepository }],
  exports: [PartnersService],
})
export class PartnersModule {}
