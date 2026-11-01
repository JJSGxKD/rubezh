import { Module } from "@nestjs/common";
import { NameRulesCoreModule } from "./name-rules-core.module.js";
import { RecleanQueue } from "./name-rules-reclean.job.js";
import { NameRulesRecleanService, RECLEAN_QUEUE } from "./name-rules-reclean.service.js";
import { NameRulesStatsService } from "./name-rules-stats.service.js";
import { NameRulesService } from "./name-rules.service.js";

/**
 * Правила фильтра имён для панели: список, правка, проверка на примерах,
 * статистика срабатываний и перечистка старых ников. Права берутся из глобального `RolesModule`, база и
 * Redis — из глобальных `DatabaseModule` и `RedisModule`. Кэш и хранилище,
 * которые читает вход игрока, — в `NameRulesCoreModule` (причина деления — там).
 */
@Module({
  imports: [NameRulesCoreModule],
  providers: [NameRulesService, NameRulesStatsService, NameRulesRecleanService, RecleanQueue, { provide: RECLEAN_QUEUE, useExisting: RecleanQueue }],
  exports: [NameRulesService, NameRulesStatsService, NameRulesRecleanService],
})
export class NameRulesModule {}
