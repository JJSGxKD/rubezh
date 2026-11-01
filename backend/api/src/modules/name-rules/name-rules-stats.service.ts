import { Inject, Injectable } from "@nestjs/common";
import { ValidationError } from "../../common/domain-error.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { NAME_RULE_HITS_REPOSITORY, type NameRuleHitsRepository, type NameRuleStatsRow } from "./name-rule-hits.repository.js";

/**
 * Статистика срабатываний правил фильтра имён для панели (Р168, tasks/T-0340):
 * по каждому правилу — сколько раз сработало за окно и когда в последний раз,
 * без ников и идентификаторов игроков. Читает право `names.edit`.
 */

/** Окна статистики, сутки: последние N суток UTC, сегодняшние включительно. */
export const STATS_WINDOWS = [7, 30, 90] as const;
export type StatsWindow = (typeof STATS_WINDOWS)[number];

const DAY_MS = 86_400_000;

export interface NameRuleStatsView {
  days: StatsWindow;
  /** начало окна, `YYYY-MM-DD` (UTC), включительно */
  since: string;
  /** первые сутки, за которые вообще есть счётчики; `null` — учёта ещё не было */
  trackedSince: string | null;
  /** сумма по правилам за окно */
  totalHits: number;
  /** все правила, в том числе с нулём */
  rules: NameRuleStatsRow[];
}

@Injectable()
export class NameRulesStatsService {
  constructor(
    @Inject(NAME_RULE_HITS_REPOSITORY) private readonly hits: NameRuleHitsRepository,
    private readonly roles: RolesService,
  ) {}

  async stats(actor: AccountRef, days: number, at = new Date()): Promise<NameRuleStatsView> {
    await this.roles.require(actor, "names.edit");
    const window = STATS_WINDOWS.find((candidate) => candidate === days);
    if (window === undefined) throw new ValidationError("Окно — 7, 30 или 90 суток");
    const since = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) - (window - 1) * DAY_MS).toISOString().slice(0, 10);
    const { rules, trackedSince } = await this.hits.statsFor(since);
    return { days: window, since, trackedSince, totalHits: rules.reduce((sum, rule) => sum + rule.hits, 0), rules };
  }
}
