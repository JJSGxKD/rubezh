import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import {
  REPORT_MAX_DAYS,
  csvDate,
  fetchCustomerReport,
  fetchCustomers,
  formatCents,
  formatPercent,
  reportCsv,
  reportFileName,
  reportPeriodProblem,
  retentionText,
  type CustomerReport,
} from "../src/api/customer-report";
import { fakeFetch, json } from "./helpers";

/**
 * Отчёт заказчику в панели (tasks/T-0225, docs/35-stage4-plan.md Р140): CSV
 * собирается из того же ответа, что и экран, и открывается в Excel без
 * настроек — UTF-8 с BOM, разделитель `;`, даты `ДД.ММ.ГГГГ`, деньги с двумя
 * знаками через запятую.
 */

const cell = (kept: number, pending = 0, unknown = 0) => ({ kept, pending, unknown });

const REPORT: CustomerReport = {
  customer: "Канал «Игровой угол»",
  from: "2026-10-01",
  to: "2026-10-30",
  rows: [
    {
      day: "2026-10-24",
      taskId: "sub_game_corner",
      title: "Канал «Игровой угол»",
      payModel: "cpa",
      shown: 8400,
      opened: 1260,
      completed: 940,
      retention: { d1: cell(900), d3: cell(800), d7: cell(610) },
      paid: 610,
      amountCents: 24400,
    },
    {
      day: "2026-10-25",
      taskId: "rs_task",
      title: "Партнёр; с точкой с запятой",
      payModel: "rs",
      shown: 100,
      opened: 10,
      completed: 4,
      retention: { d1: cell(0, 4), d3: cell(0, 4), d7: cell(0, 4) },
      paid: null,
      amountCents: null,
    },
  ],
  totals: {
    shown: 8500,
    opened: 1270,
    completed: 944,
    retention: { d1: cell(900, 4), d3: cell(800, 4), d7: cell(610, 4) },
    paid: 610,
    amountCents: 24400,
    hasRevenueShare: true,
  },
  conversions: { opened: 0.1494, completed: 0.7433, keptD7: 0.6462 },
};

describe("CSV отчёта заказчику", () => {
  const text = reportCsv(REPORT);
  const lines = text.slice(1).split("\r\n");

  it("UTF-8 с BOM, строки через CRLF", () => {
    expect(text.startsWith("﻿")).toBe(true);
    expect(text).toContain("\r\n");
  });

  it("заголовок: день, задание, показы, нажатия, выполнения, удержание, к оплате", () => {
    expect(lines[0]).toBe("день;задание;показы;нажатия;выполнения;остались на 1-й день;остались на 3-й день;остались на 7-й день;к оплате, $");
  });

  it("дата — 24.10.2026, сумма — 244,00 через запятую, разделитель — «;»", () => {
    expect(lines[1]).toBe("24.10.2026;Канал «Игровой угол»;8400;1260;940;900;800;610;244,00");
  });

  it("RS — «по отчёту заказчика»; «ещё рано» — пусто; поле с «;» в кавычках", () => {
    expect(lines[2]).toBe('25.10.2026;"Партнёр; с точкой с запятой";100;10;4;;;;по отчёту заказчика');
  });

  it("итоговая строка «Всего»: при RS-заданиях сумма CPA и пометка", () => {
    expect(lines[3]).toBe("Всего;;8500;1270;944;900;800;610;244,00 + по отчёту заказчика");
  });

  it("ячейка, начинающаяся с «=», не становится формулой", () => {
    const hostile = reportCsv({ ...REPORT, rows: [{ ...REPORT.rows[0]!, title: "=HYPERLINK(1)" }] });
    expect(hostile).toContain(";'=HYPERLINK(1);");
  });

  it("в файле нет идентификаторов игроков", () => {
    expect(text).not.toMatch(/accountId|platformUserId/);
  });
});

describe("форматы", () => {
  it("дата и деньги", () => {
    expect(csvDate("2026-10-24")).toBe("24.10.2026");
    expect(formatCents(24400)).toBe("244,00");
    expect(formatCents(5)).toBe("0,05");
    expect(formatCents(0)).toBe("0,00");
    expect(formatCents(123456789)).toBe("1234567,89");
  });

  it("доля — процентами; null — «—»", () => {
    expect(formatPercent(0.1494)).toBe("14,9%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(null)).toBe("—");
  });

  it("удержание: «ещё рано», «неизвестно», число", () => {
    expect(retentionText(cell(0, 5), 5)).toEqual({ kind: "early" });
    expect(retentionText(cell(2, 3), 5)).toEqual({ kind: "count", kept: 2, pending: 3 });
    expect(retentionText(cell(0, 0, 5), 5)).toEqual({ kind: "unknown" });
    expect(retentionText(cell(3, 0, 2), 5)).toEqual({ kind: "count", kept: 3, pending: 0 });
    expect(retentionText(cell(0), 0)).toEqual({ kind: "count", kept: 0, pending: 0 });
  });

  it("имя файла: заказчик латиницей и период", () => {
    expect(reportFileName(REPORT)).toBe("report-kanal-igrovoy-ugol-2026-10-01-2026-10-30.csv");
    expect(reportFileName({ ...REPORT, customer: "???" })).toBe("report-customer-2026-10-01-2026-10-30.csv");
  });
});

describe("период", () => {
  it("до 92 дней включительно", () => {
    expect(REPORT_MAX_DAYS).toBe(92);
    expect(reportPeriodProblem("2026-08-01", "2026-10-31")).toBeNull();
    expect(reportPeriodProblem("2026-08-01", "2026-11-01")).toBe("Не длиннее 92 дней");
    expect(reportPeriodProblem("2026-10-30", "2026-10-01")).toBe("Дата «С» позже даты «По»");
    expect(reportPeriodProblem("", "2026-10-01")).toBe("Укажите обе даты");
  });
});

describe("запросы", () => {
  it("список заказчиков и отчёт идут по своим адресам", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { customers: ["Канал «Игровой угол»"] } }), json(200, { data: REPORT }));
    const api = new AdminApi(fetch);

    const customers = await fetchCustomers(api);
    expect(customers.ok && customers.data).toEqual(["Канал «Игровой угол»"]);
    expect(calls[0]?.url).toBe("/api/v1/admin/customer-report/customers");

    const report = await fetchCustomerReport(api, "Канал «Игровой угол»", "2026-10-01", "2026-10-30");
    expect(report.ok && report.data.totals.completed).toBe(944);
    expect(calls[1]?.url).toBe(`/api/v1/admin/customer-report?${new URLSearchParams({ customer: "Канал «Игровой угол»", from: "2026-10-01", to: "2026-10-30" }).toString()}`);
  });
});
