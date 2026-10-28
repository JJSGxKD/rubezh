import { Module } from "@nestjs/common";
import { NameRulesCoreModule } from "./name-rules-core.module.js";
import { NameRulesService } from "./name-rules.service.js";

/**
 * Правила фильтра имён для панели: список, правка и проверка на примерах.
 * Права берутся из глобального `RolesModule`. Кэш и хранилище, которые читает
 * вход игрока, — в `NameRulesCoreModule` (причина деления — там).
 */
@Module({
  imports: [NameRulesCoreModule],
  providers: [NameRulesService],
  exports: [NameRulesService],
})
export class NameRulesModule {}
