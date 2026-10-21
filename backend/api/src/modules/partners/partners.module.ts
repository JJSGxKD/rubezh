import { Module } from "@nestjs/common";
import { LinksModule } from "../links/links.module.js";
import { PARTNER_LINKS, PrismaPartnerLinksSource } from "./partner-links.repository.js";
import { PARTNERS_REPOSITORY, PrismaPartnersRepository } from "./partners.repository.js";
import { PartnersService } from "./partners.service.js";

/**
 * Партнёры (docs/35-stage4-plan.md WP41, часть 2): кто приводит игроков
 * своими промокодами и ссылками. Привязку по коду пишет модуль промокодов
 * при активации кода партнёра; этот модуль — карточки партнёров, их ссылки
 * и статистика для панели.
 */
@Module({
  imports: [LinksModule],
  providers: [PartnersService, { provide: PARTNERS_REPOSITORY, useClass: PrismaPartnersRepository }, { provide: PARTNER_LINKS, useClass: PrismaPartnerLinksSource }],
  exports: [PartnersService],
})
export class PartnersModule {}
