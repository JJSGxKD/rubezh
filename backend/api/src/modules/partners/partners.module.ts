import { Module } from "@nestjs/common";
import { PARTNER_FUNNEL, PrismaFunnelRepository } from "../funnel/funnel.repository.js";
import { LINKS_REPOSITORY, PrismaLinksRepository } from "../links/links.repository.js";
import { PROMO_CODES_REPOSITORY, PrismaPromoCodesRepository } from "../promo-codes/promo-codes.repository.js";
import { PARTNER_ACCOUNTS, PARTNER_PROMOS, PartnerCabinet, PrismaPartnerAccounts, PrismaPartnerPromos } from "./partner-cabinet.js";
import { CABINET_FUNNEL, PrismaCabinetFunnel } from "./partner-cabinet-funnel.js";
import { PartnerLinkBinder } from "./partner-links.js";
import { PARTNER_LINKS, PrismaPartnerLinksSource } from "./partner-links.repository.js";
import { PARTNERS_REPOSITORY, PrismaPartnersRepository } from "./partners.repository.js";
import { PartnersService } from "./partners.service.js";

/**
 * Партнёры (docs/35-stage4-plan.md WP41, часть 2): кто приводит игроков
 * своими промокодами и ссылками. Привязку по коду пишет модуль промокодов
 * при активации кода партнёра, по ссылке — `PartnerLinkBinder` из записи
 * сессии (T-0067); этот модуль — карточки партнёров, их ссылки и статистика
 * для панели. Кабинет партнёра (T-0217) — связь карточки с аккаунтом и точка, где решается, чей кабинет открыт;
 * его ссылки и копии промокодов (T-0218) заводятся репозиториями ссылок и промокодов: сервис промокодов сам
 * импортирует этот модуль, и обратный импорт замкнул бы цикл.
 *
 * Репозиторий ссылок здесь свой экземпляр того же класса, что у модуля
 * ссылок: карточке партнёра нужны только клики и запуски — теми же
 * запросами, что в списке ссылок, чтобы числа совпадали, — а контроллер
 * переходника и сервис ссылок ей ни к чему. Так же — репозиторий воронки:
 * карточке нужен только отчёт по игрокам партнёра (T-0068). Воронка кабинета (T-0219) читает привязки и клики
 * сама: ей нужны вехи с порогом группы, а не отчёт карточки для команды.
 */
@Module({
  providers: [
    PartnersService,
    PartnerLinkBinder,
    PartnerCabinet,
    { provide: PARTNER_ACCOUNTS, useClass: PrismaPartnerAccounts },
    { provide: PARTNERS_REPOSITORY, useClass: PrismaPartnersRepository },
    { provide: LINKS_REPOSITORY, useClass: PrismaLinksRepository },
    { provide: PARTNER_LINKS, useClass: PrismaPartnerLinksSource },
    { provide: PARTNER_FUNNEL, useClass: PrismaFunnelRepository },
    { provide: PROMO_CODES_REPOSITORY, useClass: PrismaPromoCodesRepository },
    { provide: PARTNER_PROMOS, useClass: PrismaPartnerPromos },
    { provide: CABINET_FUNNEL, useClass: PrismaCabinetFunnel },
  ],
  exports: [PartnersService, PartnerLinkBinder, PartnerCabinet],
})
export class PartnersModule {}
