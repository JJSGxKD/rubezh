import { describe, expect, it } from "vitest";
import {
  REPORT_MAX_DAYS,
  buildCustomerReport,
  customerReportQuerySchema,
  type CompletionGroup,
  type EventCount,
  type ReportTask,
  type ReportWindow,
} from "../src/modules/tasks/customer-report.js";

/**
 * Отчёт заказчику партнёрских заданий (docs/35-stage4-plan.md Р140,
 * tasks/T-0225): чистая сборка строк, итогов и конверсий из счётчиков. Деньги —
 * целые центы; `accountId` и любые имена игроков в отчёт попасть не могут —
 * сборка их не получает.
 */

const DAY = "2026-10-24";

function task(patch: Partial<ReportTask> = {}): ReportTask {
  return { taskId: "sub_game_corner", title: "Канал «Игровой угол»", payModel: "cpa", rate: 40, holdDays: 3, ...patch };
}

/** Окно с отметками; по умолчанию закрытое — ждать нечего. */
function window(patch: Partial<ReportWindow> = {}): ReportWindow {
  return { open: false, heldD1: null, heldD3: null, heldD7: null, ...patch };
}

function completions(count: number, win: ReportWindow | null, patch: Partial<CompletionGroup> = {}): CompletionGroup {
  return { day: DAY, taskId: "sub_game_corner", count, window: win, ...patch };
}

function build(tasks: ReportTask[], groups: CompletionGroup[], events: EventCount[] = []) {
  return buildCustomerReport({ customer: "Канал «Игровой угол»", from: DAY, to: DAY, tasks, events, completions: groups });
}

describe("к оплате у CPA", () => {
  it("ставка 0,40 $, срок 3 дня, 10 выполнений, у 6 отметка 3-го дня true — 2,40 $", () => {
    const report = build([task()], [completions(6, window({ heldD3: true })), completions(4, window({ heldD3: false }))]);
    const [row] = report.rows;
    expect(row).toMatchObject({ completed: 10, paid: 6, amountCents: 240, payModel: "cpa" });
    expect(report.totals).toMatchObject({ paid: 6, amountCents: 240 });
  });

  it("срок 0 — оплачиваются все 10, окно не нужно", () => {
    const report = build([task({ holdDays: 0 })], [completions(10, null)]);
    expect(report.rows[0]).toMatchObject({ completed: 10, paid: 10, amountCents: 400 });
  });

  it("пустая отметка и выполнение без окна при сроке больше нуля не оплачиваются", () => {
    const report = build([task({ holdDays: 7 })], [completions(3, window({ heldD7: null })), completions(2, null), completions(5, window({ heldD7: true }))]);
    expect(report.rows[0]).toMatchObject({ completed: 10, paid: 5, amountCents: 200 });
  });

  it("RS — «по отчёту заказчика»: суммы и оплачиваемых нет, итог не выдумывает цифру", () => {
    const report = build([task({ payModel: "rs", rate: 1500, holdDays: 0 })], [completions(10, null)]);
    expect(report.rows[0]).toMatchObject({ completed: 10, payModel: "rs", paid: null, amountCents: null });
    expect(report.totals).toMatchObject({ amountCents: 0, hasRevenueShare: true });
  });

  it("итог суммирует только CPA и помечает, что часть — по отчёту заказчика", () => {
    const report = build(
      [task({ holdDays: 0 }), task({ taskId: "rs_task", payModel: "rs", rate: 500, holdDays: 0 })],
      [completions(10, null), completions(7, null, { taskId: "rs_task" })],
    );
    expect(report.totals).toMatchObject({ completed: 17, amountCents: 400, hasRevenueShare: true });
  });
});

describe("удержание", () => {
  it("отметки true считаются, false — нет", () => {
    const report = build([task()], [completions(4, window({ heldD1: true, heldD3: true, heldD7: true })), completions(2, window({ heldD1: true, heldD3: false, heldD7: false }))]);
    expect(report.rows[0]?.retention).toEqual({
      d1: { kept: 6, pending: 0, unknown: 0 },
      d3: { kept: 4, pending: 0, unknown: 0 },
      d7: { kept: 4, pending: 0, unknown: 0 },
    });
  });

  it("отметка 7-го дня ещё не наступила — «ещё рано» (pending), а не «неизвестно»", () => {
    const report = build([task()], [completions(5, window({ open: true, heldD1: true, heldD3: null, heldD7: null }))]);
    expect(report.rows[0]?.retention).toEqual({
      d1: { kept: 5, pending: 0, unknown: 0 },
      d3: { kept: 0, pending: 5, unknown: 0 },
      d7: { kept: 0, pending: 5, unknown: 0 },
    });
  });

  it("пустая отметка в закрытом окне и выполнение без окна — «неизвестно»", () => {
    const report = build([task()], [completions(3, window({ open: false })), completions(2, null)]);
    expect(report.rows[0]?.retention.d7).toEqual({ kept: 0, pending: 0, unknown: 5 });
  });

  it("итоги по удержанию — сумма строк", () => {
    const report = build(
      [task()],
      [completions(4, window({ heldD7: true })), completions(6, window({ heldD7: true }), { day: "2026-10-25" })],
    );
    expect(report.totals.retention.d7.kept).toBe(10);
  });
});

describe("конверсии", () => {
  it("нажатия / показы, выполнения / нажатия, остались на 7-й день / выполнения", () => {
    const report = build(
      [task()],
      [completions(10, window({ heldD7: true }), {}), completions(10, window({ heldD7: false }))],
      [{ day: DAY, taskId: "sub_game_corner", shown: 800, opened: 200 }],
    );
    expect(report.totals).toMatchObject({ shown: 800, opened: 200, completed: 20 });
    expect(report.conversions).toEqual({ opened: 0.25, completed: 0.1, keptD7: 0.5 });
  });

  it("показов 0 — конверсия null («—»), а не деление на ноль", () => {
    const report = build([task()], [completions(3, null)], [{ day: DAY, taskId: "sub_game_corner", shown: 0, opened: 0 }]);
    expect(report.conversions).toEqual({ opened: null, completed: null, keptD7: 0 });
    expect(JSON.stringify(report)).not.toMatch(/NaN|Infinity/);
  });

  it("выполнений 0 — доля удержавшихся null", () => {
    const report = build([task()], [], [{ day: DAY, taskId: "sub_game_corner", shown: 10, opened: 2 }]);
    expect(report.conversions).toEqual({ opened: 0.2, completed: 0, keptD7: null });
  });
});

describe("строки", () => {
  it("строка — день × задание; события и выполнения одного дня и задания сходятся в одну", () => {
    const report = build([task()], [completions(2, null), completions(3, window({ heldD3: true }))], [{ day: DAY, taskId: "sub_game_corner", shown: 9, opened: 4 }]);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ day: DAY, taskId: "sub_game_corner", title: "Канал «Игровой угол»", shown: 9, opened: 4, completed: 5 });
  });

  it("порядок — по дням, внутри дня по заданиям; пустых строк нет", () => {
    const report = build(
      [task({ taskId: "b_task" }), task({ taskId: "a_task" })],
      [completions(1, null, { day: "2026-10-25", taskId: "a_task" })],
      [
        { day: "2026-10-25", taskId: "b_task", shown: 1, opened: 0 },
        { day: DAY, taskId: "b_task", shown: 2, opened: 1 },
        { day: DAY, taskId: "a_task", shown: 0, opened: 0 },
      ],
    );
    expect(report.rows.map((row) => `${row.day} ${row.taskId}`)).toEqual([`${DAY} b_task`, "2026-10-25 a_task", "2026-10-25 b_task"]);
  });

  it("события и выполнения чужих заданий в отчёт не попадают", () => {
    const report = build(
      [task()],
      [completions(5, null, { taskId: "other_customer_task" })],
      [{ day: DAY, taskId: "other_customer_task", shown: 100, opened: 50 }],
    );
    expect(report.rows).toEqual([]);
    expect(report.totals).toMatchObject({ shown: 0, opened: 0, completed: 0 });
  });

  it("название — заданное, без него — id задания", () => {
    const report = build([task({ title: null })], [completions(1, null)]);
    expect(report.rows[0]?.title).toBe("sub_game_corner");
  });

  it("в отчёте нет идентификаторов игроков", () => {
    const text = JSON.stringify(build([task()], [completions(5, window({ heldD3: true }))], [{ day: DAY, taskId: "sub_game_corner", shown: 9, opened: 4 }]));
    expect(text).not.toMatch(/accountId|account_id|platformUserId|username/i);
  });
});

describe("запрос отчёта", () => {
  const ok = { customer: "Канал «Игровой угол»", from: "2026-10-01", to: "2026-10-30" };

  it("принимает заказчика и период", () => {
    expect(customerReportQuerySchema.parse(ok)).toEqual(ok);
  });

  it("не принимает пустого заказчика и дат не того вида", () => {
    expect(customerReportQuerySchema.safeParse({ ...ok, customer: "  " }).success).toBe(false);
    expect(customerReportQuerySchema.safeParse({ ...ok, from: "01.10.2026" }).success).toBe(false);
    expect(customerReportQuerySchema.safeParse({ ...ok, to: "2026-13-40" }).success).toBe(false);
  });

  it("«с» позже «по» — отказ", () => {
    expect(customerReportQuerySchema.safeParse({ ...ok, from: "2026-10-30", to: "2026-10-01" }).success).toBe(false);
  });

  it(`не больше ${String(REPORT_MAX_DAYS)} дней включительно`, () => {
    expect(REPORT_MAX_DAYS).toBe(92);
    expect(customerReportQuerySchema.safeParse({ ...ok, from: "2026-08-01", to: "2026-10-31" }).success).toBe(true);
    expect(customerReportQuerySchema.safeParse({ ...ok, from: "2026-08-01", to: "2026-11-01" }).success).toBe(false);
  });
});
