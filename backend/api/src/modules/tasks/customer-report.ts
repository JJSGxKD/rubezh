import { z } from "zod";
import { paidRetention, RETENTION_DAYS, type RetentionDay } from "./channel-watch-rules.js";
import type { PayModel } from "./task-rules.js";

/**
 * Отчёт заказчику партнёрских заданий (docs/35-stage4-plan.md Р140,
 * tasks/T-0225): по дням и заданиям заказчика — показы, нажатия, выполнения,
 * сколько игроков остались в канале на 1-й, 3-й и 7-й день и сколько платить
 * по CPA. Чистая сборка из счётчиков: идентификаторов игроков в ней нет с
 * самого входа, поэтому и в ответ они попасть не могут. Деньги — целые центы.
 *
 * Сутки — по Москве, как у заданий и отчётов команды; считает их база.
 */

/** Дольше трёх месяцев отчёт не режут: события читаются выборкой по периоду. */
export const REPORT_MAX_DAYS = 92;
const DAY_MS = 86_400_000;

/** Московские сутки `ГГГГ-ММ-ДД`, существующие в календаре. */
const dayString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const at = Date.parse(`${value}T00:00:00Z`);
    return !Number.isNaN(at) && new Date(at).toISOString().startsWith(value);
  });

/** Запрос отчёта: заказчик и период по московским суткам, обе границы включительно. */
export const customerReportQuerySchema = z
  .object({ customer: z.string().trim().min(1).max(80), from: dayString, to: dayString })
  .refine((query) => query.from <= query.to, { message: "«с» позже «по»", path: ["from"] })
  .refine((query) => (Date.parse(`${query.to}T00:00:00Z`) - Date.parse(`${query.from}T00:00:00Z`)) / DAY_MS < REPORT_MAX_DAYS, {
    message: `период длиннее ${String(REPORT_MAX_DAYS)} дней`,
    path: ["to"],
  });
export type CustomerReportQuery = z.infer<typeof customerReportQuerySchema>;

/** Задание заказчика: что нужно для суммы к оплате и названия. */
export interface ReportTask {
  taskId: string;
  title: string | null;
  payModel: PayModel;
  /** у `cpa` — центы доллара за выполнение, у `rs` — сотые доли процента */
  rate: number;
  holdDays: number;
}

/** Показы и нажатия задания за московский день. */
export interface EventCount {
  day: string;
  taskId: string;
  shown: number;
  opened: number;
}

/** Окно наблюдения за подпиской: идёт ли оно ещё и отметки удержания. */
export interface ReportWindow {
  /** окно не закрыто: пустые отметки ещё могут встать */
  open: boolean;
  heldD1: boolean | null;
  heldD3: boolean | null;
  heldD7: boolean | null;
}

/** Заборы награды за московский день с одним и тем же окном: `window: null` — окна нет. */
export interface CompletionGroup {
  day: string;
  taskId: string;
  count: number;
  window: ReportWindow | null;
}

/**
 * Удержание на один срок: `kept` — были в канале, `pending` — отметка ещё
 * может встать («ещё рано»), `unknown` — не встанет (площадка не ответила или
 * окна нет). Не вошедшие никуда — отписались.
 */
export interface RetentionCell {
  kept: number;
  pending: number;
  unknown: number;
}

export type RetentionCells = Record<`d${RetentionDay}`, RetentionCell>;

export interface ReportRow {
  day: string;
  taskId: string;
  title: string;
  payModel: PayModel;
  shown: number;
  opened: number;
  completed: number;
  retention: RetentionCells;
  /** оплачиваемых выполнений; у `rs` — `null`: долю считает заказчик */
  paid: number | null;
  /** к оплате в центах; у `rs` — `null` */
  amountCents: number | null;
}

export interface ReportTotals {
  shown: number;
  opened: number;
  completed: number;
  retention: RetentionCells;
  paid: number;
  amountCents: number;
  /** в строках есть задания с долей дохода: их сумма в итог не входит */
  hasRevenueShare: boolean;
}

/** Доли в 0…1; `null` — делить не на что. */
export interface ReportConversions {
  opened: number | null;
  completed: number | null;
  keptD7: number | null;
}

export interface CustomerReport {
  customer: string;
  from: string;
  to: string;
  rows: ReportRow[];
  totals: ReportTotals;
  conversions: ReportConversions;
}

/** Чтение отчёта из хранилища: репозиторий отдаёт счётчики, а не игроков. */
export interface CustomerReportSource {
  /** задания заказчика, включая выключенные: по ним ещё идут выплаты */
  tasksOf(customer: string): Promise<ReportTask[]>;
  eventCounts(taskIds: readonly string[], from: string, to: string): Promise<EventCount[]>;
  completions(taskIds: readonly string[], from: string, to: string): Promise<CompletionGroup[]>;
}

const MARK_FIELDS = { 1: "heldD1", 3: "heldD3", 7: "heldD7" } as const satisfies Record<RetentionDay, keyof ReportWindow>;

const emptyCell = (): RetentionCell => ({ kept: 0, pending: 0, unknown: 0 });
const emptyCells = (): RetentionCells => ({ d1: emptyCell(), d3: emptyCell(), d7: emptyCell() });

/** Куда ложится одно выполнение с отметкой дня `days`: «был», «ещё рано» или «неизвестно». */
function addMark(cell: RetentionCell, window: ReportWindow | null, days: RetentionDay, count: number): void {
  const mark = window === null ? null : window[MARK_FIELDS[days]];
  if (mark === true) cell.kept += count;
  else if (mark === null) {
    if (window !== null && window.open) cell.pending += count;
    else cell.unknown += count;
  }
}

function addCells(into: RetentionCells, from: RetentionCells): void {
  for (const key of ["d1", "d3", "d7"] as const) {
    into[key].kept += from[key].kept;
    into[key].pending += from[key].pending;
    into[key].unknown += from[key].unknown;
  }
}

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

interface Bucket {
  shown: number;
  opened: number;
  completed: number;
  retention: RetentionCells;
  paid: number;
}

/** Собрать отчёт: строки день × задание только с движением, итоги и доли. */
export function buildCustomerReport(input: {
  customer: string;
  from: string;
  to: string;
  tasks: readonly ReportTask[];
  events: readonly EventCount[];
  completions: readonly CompletionGroup[];
}): CustomerReport {
  const tasks = new Map(input.tasks.map((task) => [task.taskId, task]));
  const buckets = new Map<string, Bucket & { day: string; task: ReportTask }>();
  const bucketOf = (day: string, taskId: string): (Bucket & { day: string; task: ReportTask }) | null => {
    const task = tasks.get(taskId);
    if (task === undefined) return null;
    const key = `${day}\u0000${taskId}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { day, task, shown: 0, opened: 0, completed: 0, retention: emptyCells(), paid: 0 };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  for (const event of input.events) {
    const bucket = bucketOf(event.day, event.taskId);
    if (bucket === null) continue;
    bucket.shown += event.shown;
    bucket.opened += event.opened;
  }
  for (const group of input.completions) {
    const bucket = bucketOf(group.day, group.taskId);
    if (bucket === null) continue;
    bucket.completed += group.count;
    for (const days of RETENTION_DAYS) addMark(bucket.retention[`d${String(days)}` as keyof RetentionCells], group.window, days, group.count);
    if (paidRetention(group.window, bucket.task.holdDays)) bucket.paid += group.count;
  }

  const rows: ReportRow[] = [...buckets.values()]
    .filter((bucket) => bucket.shown + bucket.opened + bucket.completed > 0)
    .sort((a, b) => (a.day === b.day ? (a.task.taskId < b.task.taskId ? -1 : 1) : a.day < b.day ? -1 : 1))
    .map((bucket) => {
      const cpa = bucket.task.payModel === "cpa";
      return {
        day: bucket.day,
        taskId: bucket.task.taskId,
        title: bucket.task.title ?? bucket.task.taskId,
        payModel: bucket.task.payModel,
        shown: bucket.shown,
        opened: bucket.opened,
        completed: bucket.completed,
        retention: bucket.retention,
        paid: cpa ? bucket.paid : null,
        amountCents: cpa ? bucket.paid * bucket.task.rate : null,
      };
    });

  const totals: ReportTotals = { shown: 0, opened: 0, completed: 0, retention: emptyCells(), paid: 0, amountCents: 0, hasRevenueShare: false };
  for (const row of rows) {
    totals.shown += row.shown;
    totals.opened += row.opened;
    totals.completed += row.completed;
    addCells(totals.retention, row.retention);
    totals.paid += row.paid ?? 0;
    totals.amountCents += row.amountCents ?? 0;
    if (row.payModel === "rs") totals.hasRevenueShare = true;
  }

  return {
    customer: input.customer,
    from: input.from,
    to: input.to,
    rows,
    totals,
    conversions: {
      opened: ratio(totals.opened, totals.shown),
      completed: ratio(totals.completed, totals.opened),
      keptD7: ratio(totals.retention.d7.kept, totals.completed),
    },
  };
}

/** Прочитать счётчики и собрать отчёт; у заказчика нет заданий — пустой отчёт без обращения к событиям. */
export async function loadCustomerReport(source: CustomerReportSource, query: CustomerReportQuery): Promise<CustomerReport> {
  const tasks = await source.tasksOf(query.customer);
  const ids = tasks.map((task) => task.taskId);
  const [events, completions] = ids.length === 0 ? [[], []] : await Promise.all([source.eventCounts(ids, query.from, query.to), source.completions(ids, query.from, query.to)]);
  return buildCustomerReport({ customer: query.customer, from: query.from, to: query.to, tasks, events, completions });
}
