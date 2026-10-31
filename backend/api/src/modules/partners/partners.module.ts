import { Module } from "@nestjs/common";
import { PARTNER_FUNNEL, PrismaFunnelRepository } from "../funnel/funnel.repository.js";
import { LINKS_REPOSITORY, PrismaLinksRepository } from "../links/links.repository.js";
import { PartnerLinkBinder } from "./partner-links.js";
import { PARTNER_LINKS, PrismaPartnerLinksSource } from "./partner-links.repository.js";
import { PARTNERS_REPOSITORY, PrismaPartnersRepository } from "./partners.repository.js";
import { PartnersService } from "./partners.service.js";

/**
 * Партнёры (docs/35-stage4-plan.md WP41, часть 2): кто приводит игроков
 * своими промокодами и ссылками. Привязку по коду пишет модуль промокодов
 * при активации кода партнёра, по ссылке — `PartnerLinkBinder` из записи
 * сессии (T-0067); этот модуль — карточки партнёров, их ссылки и статистика
 * для панели.
 *
 * Репозиторий ссылок здесь свой экземпляр того же класса, что у модуля
 * ссылок: карточке партнёра нужны только клики и запуски — теми же
 * запросами, что в списке ссылок, чтобы числа совпадали, — а контроллер
 * переходника и сервис ссылок ей ни к чему. Так же — репозиторий воронки:
 * карточке нужен только отчёт по игрокам партнёра (T-0068).
 */
@Module({
  providers: [
    PartnersService,
    PartnerLinkBinder,
    { provide: PARTNERS_REPOSITORY, useClass: PrismaPartnersRepository },
    { provide: LINKS_REPOSITORY, useClass: PrismaLinksRepository },
    { provide: PARTNER_LINKS, useClass: PrismaPartnerLinksSource },
    { provide: PARTNER_FUNNEL, useClass: PrismaFunnelRepository },
  ],
  exports: [PartnersService, PartnerLinkBinder],
})
export class PartnersModule {}
