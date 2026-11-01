import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { POINT_PERIODS, type PointsPeriod } from "./task-points.js";
import { periodStartSql } from "./tasks.repository.js";

/**
 * Очки заданий в базе (tasks/T-0105): сумма очков выполненных заданий дня и
 * недели и забранные ступени (`task_points_claim`). Границы суток и недели
 * считает база — той же `periodStartSql`, что и прогресс заданий, поэтому
 * полоса и задания всегда живут в одном сроке.
 */

export interface PointsTotals {
  /** начало сегодняшних игровых суток, `YYYY-MM-DD` */
  dayStart: string;
  /** понедельник текущей недели, `YYYY-MM-DD` */
  weekStart: string;
  daily: number;
  weekly: number;
}

export const TASK_POINTS_REPOSITORY = Symbol("TASK_POINTS_REPOSITORY");

export interface TaskPointsRepository {
  /**
   * Очки выполненных заданий текущего срока. Выполненных, а не забранных:
   * забирать задание ради очков не нужно. Полоса недели включает ежедневные
   * задания этой недели.
   */
  totals(accountId: string, at: Date): Promise<PointsTotals>;
  /** Забранные ступени текущих суток и недели: пороги по полосам. */
  claims(accountId: string, dayStart: string, weekStart: string): Promise<Record<PointsPeriod, Set<number>>>;
  /** Отметить ступень забранной; `false` — уже отмечена параллельным запросом. */
  markClaimed(input: { accountId: string; period: PointsPeriod; periodStart: string; points: number; at: Date }): Promise<boolean>;
}

const totalsSchema = z.object({ day_start: z.string(), week_start: z.string(), daily: z.number().int(), weekly: z.number().int() });
const claimSchema = z.object({ period: z.enum(POINT_PERIODS), points: z.number().int() });

@Injectable()
export class PrismaTaskPointsRepository implements TaskPointsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async totals(accountId: string, at: Date): Promise<PointsTotals> {
    // Очки — из каталога сейчас: правка `pass_points` в панели пересчитывает
    // набранное в сроке, а выключенное и партнёрское (с `params`) очков не даёт.
    const [row] = await this.prisma.$queryRaw<unknown[]>`
      WITH bounds AS (
        SELECT ${periodStartSql(Prisma.sql`'daily'`, at)} AS day_start, ${periodStartSql(Prisma.sql`'weekly'`, at)} AS week_start
      ), done AS (
        SELECT d.period::text AS period, p.period_start, d.pass_points
        FROM task_progress p
        JOIN task_def d ON d.task_id = p.task_id
        WHERE p.account_id = ${accountId}::uuid
          AND p.completed_at IS NOT NULL
          AND d.active
          AND d.params IS NULL
          AND d.period IN ('daily', 'weekly')
          AND p.period_start >= (SELECT week_start FROM bounds)
      )
      SELECT b.day_start::text AS day_start, b.week_start::text AS week_start,
        COALESCE(SUM(done.pass_points) FILTER (WHERE done.period = 'daily' AND done.period_start = b.day_start), 0)::int AS daily,
        COALESCE(SUM(done.pass_points) FILTER (
          WHERE (done.period = 'daily' AND done.period_start <= b.day_start) OR (done.period = 'weekly' AND done.period_start = b.week_start)
        ), 0)::int AS weekly
      FROM bounds b
      LEFT JOIN done ON true
      GROUP BY b.day_start, b.week_start`;
    const parsed = totalsSchema.parse(row);
    return { dayStart: parsed.day_start, weekStart: parsed.week_start, daily: parsed.daily, weekly: parsed.weekly };
  }

  async claims(accountId: string, dayStart: string, weekStart: string): Promise<Record<PointsPeriod, Set<number>>> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT period::text AS period, points
      FROM task_points_claim
      WHERE account_id = ${accountId}::uuid
        AND ((period = 'daily' AND period_start = ${dayStart}::date) OR (period = 'weekly' AND period_start = ${weekStart}::date))`;
    const claimed: Record<PointsPeriod, Set<number>> = { daily: new Set(), weekly: new Set() };
    for (const raw of rows) {
      const row = claimSchema.parse(raw);
      claimed[row.period].add(row.points);
    }
    return claimed;
  }

  async markClaimed(input: { accountId: string; period: PointsPeriod; periodStart: string; points: number; at: Date }): Promise<boolean> {
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO task_points_claim (account_id, period, period_start, points, claimed_at)
      VALUES (${input.accountId}::uuid, ${input.period}::"TaskPeriod", ${input.periodStart}::date, ${input.points}, ${input.at})
      ON CONFLICT DO NOTHING`;
    return inserted > 0;
  }
}
