import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { CompletionGroup, CustomerReportSource, EventCount, ReportTask } from "./customer-report.js";
import { PAY_MODELS } from "./task-rules.js";

/**
 * Выборки отчёта заказчику (docs/35-stage4-plan.md Р140, tasks/T-0225):
 * заказчики и их задания, показы и нажатия из событий, заборы награды с
 * окнами удержания. Всё группируется на стороне базы по московским суткам, в
 * ответ идут только счётчики — игрока ни одна выборка не возвращает.
 *
 * Запросы сырые, как у соседних таблиц модуля: границы периода — московские
 * сутки `ГГГГ-ММ-ДД`, в момент времени их переводит база.
 */

export const CUSTOMER_REPORT_REPOSITORY = Symbol("CUSTOMER_REPORT_REPOSITORY");

export interface CustomerReportRepository extends CustomerReportSource {
  /** заказчики из заданий, по алфавиту */
  customers(): Promise<string[]>;
}

const count = z.coerce.number().int().nonnegative();
const customersSchema = z.array(z.object({ customer: z.string() }));
const tasksSchema = z.array(
  z.object({ task_id: z.string(), title: z.string().nullable(), pay_model: z.enum(PAY_MODELS), rate: z.number().int(), hold_days: z.number().int() }),
);
const eventsSchema = z.array(z.object({ day: z.string(), task_id: z.string(), shown: count, opened: count }));
const completionsSchema = z.array(
  z.object({
    day: z.string(),
    task_id: z.string(),
    n: count,
    has_window: z.boolean(),
    open: z.boolean(),
    held_d1: z.boolean().nullable(),
    held_d3: z.boolean().nullable(),
    held_d7: z.boolean().nullable(),
  }),
);

@Injectable()
export class PrismaCustomerReportRepository implements CustomerReportRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async customers(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT DISTINCT customer FROM task_def WHERE customer IS NOT NULL ORDER BY customer`;
    return customersSchema.parse(rows).map((row) => row.customer);
  }

  async tasksOf(customer: string): Promise<ReportTask[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT task_id, title, pay_model, rate, hold_days FROM task_def WHERE customer = ${customer} AND pay_model IS NOT NULL ORDER BY task_id`;
    return tasksSchema.parse(rows).map((row) => ({ taskId: row.task_id, title: row.title, payModel: row.pay_model, rate: row.rate, holdDays: row.hold_days }));
  }

  async eventCounts(taskIds: readonly string[], from: string, to: string): Promise<EventCount[]> {
    // Событие читается по `occurred_at` (когда игрок увидел), а индекс по виду и `received_at`
    // (когда сервер принял): приём не раньше события и ненамного позже, поэтому окно по приёму
    // с запасом в сутки в обе стороны сужает выборку, не теряя событий с кривыми часами клиента.
    const rows = await this.prisma.$queryRaw<unknown[]>`
      WITH bounds AS (
        SELECT (${from}::date)::timestamp AT TIME ZONE ${GAME_DAY_TIME_ZONE} AS start_at,
               ((${to}::date + 1))::timestamp AT TIME ZONE ${GAME_DAY_TIME_ZONE} AS end_at
      )
      SELECT to_char(e.occurred_at AT TIME ZONE ${GAME_DAY_TIME_ZONE}, 'YYYY-MM-DD') AS day,
             e.payload->>'task' AS task_id,
             count(*) FILTER (WHERE e.event_type = 'task_shown') AS shown,
             count(*) FILTER (WHERE e.event_type = 'task_link_opened') AS opened
      FROM analytics_event e, bounds b
      WHERE e.event_type IN ('task_shown', 'task_link_opened')
        AND e.received_at >= b.start_at - interval '1 day' AND e.received_at < b.end_at + interval '1 day'
        AND e.occurred_at >= b.start_at AND e.occurred_at < b.end_at
        AND e.payload->>'task' = ANY(${[...taskIds]}::text[])
      GROUP BY 1, 2`;
    return eventsSchema.parse(rows).map((row) => ({ day: row.day, taskId: row.task_id, shown: row.shown, opened: row.opened }));
  }

  async completions(taskIds: readonly string[], from: string, to: string): Promise<CompletionGroup[]> {
    // Окно — по ключу прогресса; одно окно на выполнение, поэтому соединение строк не множит.
    // Игрок в выборку не входит: группа — число выполнений с одинаковыми отметками.
    const rows = await this.prisma.$queryRaw<unknown[]>`
      WITH bounds AS (
        SELECT (${from}::date)::timestamp AT TIME ZONE ${GAME_DAY_TIME_ZONE} AS start_at,
               ((${to}::date + 1))::timestamp AT TIME ZONE ${GAME_DAY_TIME_ZONE} AS end_at
      )
      SELECT to_char(p.claimed_at AT TIME ZONE ${GAME_DAY_TIME_ZONE}, 'YYYY-MM-DD') AS day,
             p.task_id,
             count(*) AS n,
             (w.account_id IS NOT NULL) AS has_window,
             COALESCE(w.state = 'watching', false) AS open,
             w.held_d1, w.held_d3, w.held_d7
      FROM task_progress p
      CROSS JOIN bounds b
      LEFT JOIN task_channel_watch w
        ON w.account_id = p.account_id AND w.task_id = p.task_id AND w.period_start = p.period_start
      WHERE p.task_id = ANY(${[...taskIds]}::text[])
        AND p.claimed_at >= b.start_at AND p.claimed_at < b.end_at
      GROUP BY 1, 2, 4, 5, 6, 7, 8`;
    return completionsSchema.parse(rows).map((row) => ({
      day: row.day,
      taskId: row.task_id,
      count: row.n,
      window: row.has_window ? { open: row.open, heldD1: row.held_d1, heldD3: row.held_d3, heldD7: row.held_d7 } : null,
    }));
  }
}
