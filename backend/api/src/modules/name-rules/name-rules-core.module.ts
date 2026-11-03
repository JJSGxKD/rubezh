import { Module } from "@nestjs/common";
import { BullNameRuleHitsTransport, NAME_RULE_HITS, NAME_RULE_HITS_TRANSPORT, NameRuleHits } from "./name-rule-hits.js";
import { NAME_RULE_HITS_REPOSITORY, PrismaNameRuleHitsRepository } from "./name-rule-hits.repository.js";
import { NameRulesCache } from "./name-rules-cache.service.js";
import { NAME_RULES } from "./name-rules-source.js";
import { NAME_RULES_REPOSITORY, PrismaNameRulesRepository } from "./name-rules.repository.js";

/**
 * Ядро правил фильтра имён: кэш и хранилище, которые читает чистка ника.
 *
 * Отдельно от `NameRulesModule`, потому что `AuthModule` подключает только
 * его: админская часть берёт права из `RolesModule`, а тот импортирует
 * `AuthModule`, и общий модуль замкнул бы цикл. Здесь ни `RolesModule`, ни
 * `AuthModule` нет.
 *
 * Экспорт обязателен: необязательная зависимость `PrismaAccountRepository`
 * (`@Optional() @Inject(NAME_RULES)`) без экспорта молча пуста везде, кроме
 * этого модуля, и ни один тест этого не заметит — вход перестал бы чистить
 * по правилам (то же, что с `AccessRevocations` в `auth.module.ts`). Так же с
 * `NAME_RULE_HITS`: без экспорта вход перестал бы считать срабатывания.
 */
@Module({
  providers: [
    NameRulesCache,
    { provide: NAME_RULES, useExisting: NameRulesCache },
    { provide: NAME_RULES_REPOSITORY, useClass: PrismaNameRulesRepository },
    // Счёт срабатываний (T-0340): вход игрока кладёт его в `NAME_RULE_HITS`, воркер пишет суточные счётчики.
    NameRuleHits,
    { provide: NAME_RULE_HITS, useExisting: NameRuleHits },
    { provide: NAME_RULE_HITS_TRANSPORT, useClass: BullNameRuleHitsTransport },
    { provide: NAME_RULE_HITS_REPOSITORY, useClass: PrismaNameRuleHitsRepository },
  ],
  exports: [NAME_RULES, NameRulesCache, NAME_RULES_REPOSITORY, NAME_RULE_HITS, NAME_RULE_HITS_REPOSITORY],
})
export class NameRulesCoreModule {}
