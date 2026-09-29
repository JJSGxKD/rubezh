import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { DayStats, DayWindow, SourceKind } from "./daily-stats.js";

/**
 * Цифры суток для ежедневной статистики (docs/35-stage4-plan.md §3.18) —
 * агрегатами по таблицам, которые уже есть: аккаунты с первым касанием,
 * сессии запуска, забеги, покупки, вехи воронки. Раз в сутки и по команде —
 * несколько запросов по индексам времени, без обхода в коде.
 */

export const DAILY_STATS_REPOSITORY = Symbol("DAILY_STATS_REPOSITORY");

export interface DailyStatsRepository {
  day(window: DayWindow): Promise<DayStats>;
}

const SOURCES: readonly SourceKind[] = ["organic", "click", "invite", "telegram_affiliate", "friend", "unknown"];

const count = z.coerce.number().int().nonnegative();
const accountsSchema = z.array(z.object({ kind: z.string().nullable(), n: count }));
const activeSchema = z.array(z.object({ active: count, sessions: count }));
const runsSchema = z.array(z.object({ finished: count, players: count, median: z.coerce.number().nullable() }));
const revenueSchema = z.array(z.object({ stars: count, purchases: count, refunds: count }));
const funnelSchema = z.array(
  z.object({ entered: count, app_opened: count, first_run: count, runs5: count, returned_d1: count, returned_d7: count, first_purchase: count }),
);

@Injectable()
export class PrismaDailyStatsRepository implements DailyStatsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async day({ from, to }: DayWindow): Promise<DayStats> {
    const [accounts, active, runs, revenue, funnel] = await Promise.all([
      this.prisma.$queryRaw`
        SELECT q.first_start_kind::text AS kind, count(*) AS n
        FROM account a LEFT JOIN acquisition q ON q.account_id = a.account_id
        WHERE a.created_at >= ${from} AND a.created_at < ${to}
        GROUP BY 1`,
      this.prisma.$queryRaw`
        SELECT count(DISTINCT account_id) AS active, count(*) AS sessions
        FROM account_session WHERE started_at >= ${from} AND started_at < ${to}`,
      // Забег с читами — разработчика: в статистику игроков он не идёт.
      this.prisma.$queryRaw`
        SELECT count(*) AS finished, count(DISTINCT account_id) AS players,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY survival_sec) AS median
        FROM run WHERE status = 'finished' AND NOT cheats AND finished_at >= ${from} AND finished_at < ${to}`,
      this.prisma.$queryRaw`
        SELECT
          coalesce(sum(charged_stars) FILTER (WHERE paid_at >= ${from} AND paid_at < ${to}), 0) AS stars,
          count(*) FILTER (WHERE paid_at >= ${from} AND paid_at < ${to}) AS purchases,
          count(*) FILTER (WHERE refunded_at >= ${from} AND refunded_at < ${to}) AS refunds
        FROM purchase
        WHERE mode = 'live' AND ((paid_at >= ${from} AND paid_at < ${to}) OR (refunded_at >= ${from} AND refunded_at < ${to}))`,
      this.prisma.$queryRaw`
        SELECT
          count(*) FILTER (WHERE entered_at >= ${from} AND entered_at < ${to}) AS entered,
          count(*) FILTER (WHERE app_opened_at >= ${from} AND app_opened_at < ${to}) AS app_opened,
          count(*) FILTER (WHERE first_run_started_at >= ${from} AND first_run_started_at < ${to}) AS first_run,
          count(*) FILTER (WHERE runs_5_at >= ${from} AND runs_5_at < ${to}) AS runs5,
          count(*) FILTER (WHERE returned_d1_at >= ${from} AND returned_d1_at < ${to}) AS returned_d1,
          count(*) FILTER (WHERE returned_d7_at >= ${from} AND returned_d7_at < ${to}) AS returned_d7,
          count(*) FILTER (WHERE first_purchase_at >= ${from} AND first_purchase_at < ${to}) AS first_purchase
        FROM account_funnel`,
    ]);

    const bySource: Partial<Record<SourceKind, number>> = {};
    for (const row of accountsSchema.parse(accounts)) {
      const kind = SOURCES.find((source) => source === row.kind) ?? "unknown";
      bySource[kind] = (bySource[kind] ?? 0) + row.n;
    }
    const [act] = activeSchema.parse(active);
    const [run] = runsSchema.parse(runs);
    const [money] = revenueSchema.parse(revenue);
    const [steps] = funnelSchema.parse(funnel);
    return {
      accounts: bySource,
      active: act?.active ?? 0,
      sessions: act?.sessions ?? 0,
      runs: { finished: run?.finished ?? 0, players: run?.players ?? 0, medianSurvivalSec: run?.median ?? null },
      revenue: { stars: money?.stars ?? 0, purchases: money?.purchases ?? 0, refunds: money?.refunds ?? 0 },
      funnel: {
        entered: steps?.entered ?? 0,
        appOpened: steps?.app_opened ?? 0,
        firstRun: steps?.first_run ?? 0,
        runs5: steps?.runs5 ?? 0,
        returnedD1: steps?.returned_d1 ?? 0,
        returnedD7: steps?.returned_d7 ?? 0,
        firstPurchase: steps?.first_purchase ?? 0,
      },
    };
  }
}
