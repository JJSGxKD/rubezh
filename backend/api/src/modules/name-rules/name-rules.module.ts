import { Module } from "@nestjs/common";
import { NameRuleCandidatesJob } from "./name-rule-candidates.job.js";
import { NAME_RULE_CANDIDATES_REPOSITORY, PrismaNameRuleCandidatesRepository } from "./name-rule-candidates.repository.js";
import { NameRuleCandidatesAdminService, NameRuleCandidatesService } from "./name-rule-candidates.service.js";
import { NameRulesCoreModule } from "./name-rules-core.module.js";
import { RecleanQueue } from "./name-rules-reclean.job.js";
import { NameRulesRecleanService, RECLEAN_QUEUE } from "./name-rules-reclean.service.js";
import { NameRulesStatsService } from "./name-rules-stats.service.js";
import { NameRulesService } from "./name-rules.service.js";

/**
 * Правила фильтра имён для панели: список, правка, проверка на примерах,
 * статистика срабатываний, перечистка старых ников и кандидаты в правила
 * (ночной расчёт частых слов, Р168, T-0341). Права берутся из глобального `RolesModule`, база и
 * Redis — из глобальных `DatabaseModule` и `RedisModule`. Кэш и хранилище,
 * которые читает вход игрока, — в `NameRulesCoreModule` (причина деления — там).
 */
@Module({
  imports: [NameRulesCoreModule],
  providers: [
    NameRulesService,
    NameRulesStatsService,
    NameRulesRecleanService,
    RecleanQueue,
    { provide: RECLEAN_QUEUE, useExisting: RecleanQueue },
    { provide: NAME_RULE_CANDIDATES_REPOSITORY, useClass: PrismaNameRuleCandidatesRepository },
    NameRuleCandidatesService,
    NameRuleCandidatesAdminService,
    NameRuleCandidatesJob,
  ],
  // Админский сервис — ещё и наружу: контроллер из `admin.module.ts` берёт его отсюда.
  exports: [NameRulesService, NameRulesStatsService, NameRulesRecleanService, NameRuleCandidatesAdminService],
})
export class NameRulesModule {}
