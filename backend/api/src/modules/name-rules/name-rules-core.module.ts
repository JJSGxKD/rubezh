import { Module } from "@nestjs/common";
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
 * по правилам (то же, что с `AccessRevocations` в `auth.module.ts`).
 */
@Module({
  providers: [NameRulesCache, { provide: NAME_RULES, useExisting: NameRulesCache }, { provide: NAME_RULES_REPOSITORY, useClass: PrismaNameRulesRepository }],
  exports: [NAME_RULES, NameRulesCache, NAME_RULES_REPOSITORY],
})
export class NameRulesCoreModule {}
