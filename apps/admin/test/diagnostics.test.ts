import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { fetchReports, formatBytes, prettyJson, REPORT_SHOWN_CHARS, reportSchema } from "../src/api/diagnostics";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

const AT = "2026-09-25T10:00:00.000Z";

describe("диагностика", () => {
  it("фильтры и курсор «раньше» уходят в запросе", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { reports: [] } }));
    await fetchReports(new AdminApi(fetch), { kind: "run", appVersion: "0.5.0", before: AT });
    expect(calls[0]?.url).toBe("/api/v1/admin/diagnostics/reports?kind=run&appVersion=0.5.0&before=2026-09-25T10%3A00%3A00.000Z&limit=50");
  });

  it("отчёт целиком: без Telegram ID тестера — тоже отчёт", () => {
    const report = { reportId: "r1", kind: "bench", schemaVersion: "rubezh.bench.v4", appVersion: "0.5.0", contentHash: null, installId: "i1", platform: "telegram", platformUserId: null, device: { gpu: "x" }, summary: { verdict: "go" }, payload: { frames: [1, 2] }, sizeBytes: 900, occurredAt: AT, receivedAt: AT };
    expect(reportSchema.parse(report).payload).toEqual({ frames: [1, 2] });
  });

  it("огромный отчёт на экране обрезается, размеры — по-человечески", () => {
    const big = prettyJson({ data: "x".repeat(REPORT_SHOWN_CHARS * 2) });
    expect(big.truncated).toBe(true);
    expect(big.text).toHaveLength(REPORT_SHOWN_CHARS);
    expect(prettyJson({ a: 1 })).toEqual({ text: '{\n  "a": 1\n}', truncated: false });
    expect(formatBytes(900)).toBe("900 Б");
    expect(formatBytes(2048)).toBe("2.0 КБ");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 МБ");
  });
});

describe("меню", () => {
  it("раздел — за правом его маршрутов на сервере", () => {
    expect(SECTIONS.find((section) => section.id === "diagnostics")?.permission).toBe("diagnostics.view");
  });
});
