import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { withTimeout } from "../../common/with-timeout.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Суточные счётчики срабатываний правил фильтра имён (Р168, tasks/T-0340):
 * `name_rule_hit_day (rule_id, day, hits)`. Только id правила, сутки UTC и число —
 * ни ников, ни id игроков. Запрос к базе живёт здесь, а не в сервисе
 * (docs/15-engineering-standards.md §2.3).
 */

export const NAME_RULE_HITS_REPOSITORY = Symbol("NAME_RULE_HITS_REPOSITORY");

const DB_TIMEOUT_MS = 3_000;

/** Срабатывания одного правила: `hits` — за окно, `lastDay` — за всё время хранения. */
export interface NameRuleStatsRow {
  ruleId: string;
  hits: number;
  /** `YYYY-MM-DD`; `null` — правило не срабатывало за всё время хранения */
  lastDay: string | null;
}

export interface NameRuleHitsRepository {
  /**
   * Дописать счётчики суток одним запросом: правила, которых уже нет, пропускаются, не роняя пачку.
   * `day` — `YYYY-MM-DD`, сутки UTC.
   */
  addHits(day: string, counts: Readonly<Record<string, number>>): Promise<void>;
  /** Стереть сутки старше `days`; возвращает, сколько строк убрано. */
  prune(days: number): Promise<number>;
  /** Все правила с числом за окно от `since` (включительно) и последними сутками; плюс первые сутки учёта. */
  statsFor(since: string): Promise<{ rules: NameRuleStatsRow[]; trackedSince: string | null }>;
}

const statsRowSchema = z.object({ rule_id: z.string(), hits: z.number().int(), last_day: z.union([z.date(), z.null()]) });
const trackedSchema = z.object({ first_day: z.union([z.date(), z.null()]) });

const dayText = (date: Date): string => date.toISOString().slice(0, 10);

@Injectable()
export class PrismaNameRuleHitsRepository implements NameRuleHitsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async addHits(day: string, counts: Readonly<Record<string, number>>): Promise<void> {
    const entries = Object.entries(counts).filter(([, hits]) => Number.isInteger(hits) && hits > 0);
    if (entries.length === 0) return;
    const ids = entries.map(([ruleId]) => ruleId);
    const amounts = entries.map(([, hits]) => hits);
    // JOIN с таблицей правил: правило, удалённое между отправкой и записью, не роняет всю пачку внешним ключом.
    await withTimeout(
      this.prisma.$executeRaw`
        INSERT INTO name_rule_hit_day (rule_id, day, hits)
        SELECT u.rule_id, ${day}::date, u.hits
        FROM unnest(${ids}::uuid[], ${amounts}::int[]) AS u(rule_id, hits)
        JOIN name_rule r ON r.rule_id = u.rule_id
        ON CONFLICT (rule_id, day) DO UPDATE SET hits = name_rule_hit_day.hits + EXCLUDED.hits`,
      DB_TIMEOUT_MS,
      "name-rule-hits: запись",
    );
  }

  async prune(days: number): Promise<number> {
    return await withTimeout(this.prisma.$executeRaw`DELETE FROM name_rule_hit_day WHERE day < (current_date - ${days}::int)`, DB_TIMEOUT_MS, "name-rule-hits: очистка");
  }

  async statsFor(since: string): Promise<{ rules: NameRuleStatsRow[]; trackedSince: string | null }> {
    const [rows, tracked] = await withTimeout(
      Promise.all([
        this.prisma.$queryRaw<unknown[]>`
          SELECT r.rule_id::text AS rule_id,
                 COALESCE(SUM(h.hits) FILTER (WHERE h.day >= ${since}::date), 0)::int AS hits,
                 MAX(h.day) AS last_day
          FROM name_rule r LEFT JOIN name_rule_hit_day h ON h.rule_id = r.rule_id
          GROUP BY r.rule_id`,
        this.prisma.$queryRaw<unknown[]>`SELECT MIN(day) AS first_day FROM name_rule_hit_day`,
      ]),
      DB_TIMEOUT_MS,
      "name-rule-hits: статистика",
    );
    const first = tracked[0] === undefined ? null : trackedSchema.parse(tracked[0]).first_day;
    return {
      rules: rows.map((raw) => {
        const row = statsRowSchema.parse(raw);
        return { ruleId: row.rule_id, hits: row.hits, lastDay: row.last_day === null ? null : dayText(row.last_day) };
      }),
      trackedSince: first === null ? null : dayText(first),
    };
  }
}
