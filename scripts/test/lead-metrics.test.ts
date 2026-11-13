import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет и не нужно
import { classifyFailure, median, parseSince, parseTrainLog, prStats, renderReport } from "../lead/metrics.mjs";

// Метрики конвейера тимлида (T-0478, Р224, F): подсчёт по образцовым данным.

const T = (hhmm: string, day = "2026-11-13") => `${day}T${hhmm}:00:00Z`;
const log = (...rows: string[]): string => rows.join("\n") + "\n";

describe("classifyFailure: причина провала по строке лога", () => {
  it("конфликт с файлами", () => {
    expect(classifyFailure("конфликт с dev: docs/29-admin-panel.md backend/api/src/admin.module.ts")).toEqual({
      kind: "conflict",
      files: ["docs/29-admin-panel.md", "backend/api/src/admin.module.ts"],
    });
  });

  it("свой CI красный и красный CI после влития dev — красный свой CI", () => {
    expect(classifyFailure("свой CI красный: gate=RED check=GREEN").kind).toBe("ci");
    expect(classifyFailure("CI после влития dev: RED (gate)").kind).toBe("ci");
  });

  it("красный gate пачки с одним PR — красная пачка", () => {
    expect(classifyFailure("красный gate вместе со свежим dev: https://x/runs/1").kind).toBe("batch");
  });

  it("сеть", () => {
    expect(classifyFailure("сеть: fetch не прошёл").kind).toBe("network");
  });

  it("всё остальное — прочее", () => {
    expect(classifyFailure("метка блокировка").kind).toBe("other");
    expect(classifyFailure("").kind).toBe("other");
  });
});

describe("parseTrainLog: провалы и пачки за период", () => {
  const since = Date.parse(T("00"));

  it("считает не влитые по причинам и сетевые сбои, строки до периода пропускает", () => {
    const text = log(
      `${T("09", "2026-11-12")} не влит #1: конфликт с dev: старый.md`,
      `${T("10")} не влит #2: конфликт с dev: docs/29.md a.ts`,
      `${T("11")} не влит #3: конфликт с dev: docs/29.md`,
      `${T("12")} не влит #4: свой CI красный: gate=RED check=GREEN`,
      `${T("13")} сеть: голова #5 не скачана — позже`,
      `${T("14")} сеть: fetch не прошёл — #6 позже`,
      "строка без даты не влит #9: конфликт с dev: x",
    );
    const r = parseTrainLog(text, since);
    expect(r.failures.map((f: { pr: number }) => f.pr)).toEqual([2, 3, 4]);
    expect(r.network).toBe(2);
  });

  it("пачка зелёная, если после проверки нет деления; красная — если есть", () => {
    const text = log(
      `${T("10")} пачка 101 102 103: проверка в #900`,
      `${T("11")} пачка 101 102 103: gate RED — делю, следующие пачки по 2`,
      `${T("12")} пачка 101 102: проверка в #901`,
      `${T("13")} пачка 104: проверка в #902`,
    );
    const r = parseTrainLog(text, since);
    expect(r.batches).toEqual([
      { size: 3, green: false },
      { size: 2, green: true },
      { size: 1, green: true },
    ]);
  });

  it("пустой лог — пусто", () => {
    expect(parseTrainLog("", since)).toEqual({ failures: [], network: 0, batches: [] });
  });
});

describe("prStats: PR за период", () => {
  const prs = [
    { number: 1, createdAt: T("08"), mergedAt: T("10"), reworkLabels: 0, reworkComments: 0 },
    { number: 2, createdAt: T("08"), mergedAt: T("12"), reworkLabels: 1, reworkComments: 1 },
    { number: 3, createdAt: T("08"), mergedAt: T("14"), reworkLabels: 3, reworkComments: 0 },
    { number: 4, createdAt: T("08"), mergedAt: T("16"), reworkLabels: 0, reworkComments: 2 },
  ];

  it("доля с первого ревью, круги и время до мерджа", () => {
    const s = prStats(prs);
    expect(s.total).toBe(4);
    expect(s.firstReview).toBe(1);
    expect(s.firstReviewPct).toBe(25);
    expect(s.roundsMedian).toBe(1.5);
    expect(s.roundsMax).toBe(3);
    // 2, 4, 6, 8 часов → медиана 5 часов
    expect(s.mergeMedianHours).toBe(5);
  });

  it("кругов у PR — большее из меток и комментариев, а не сумма", () => {
    expect(prStats([prs[1]]).roundsMax).toBe(1);
  });

  it("нет PR — нули без деления на ноль", () => {
    expect(prStats([])).toMatchObject({ total: 0, firstReviewPct: 0, roundsMedian: 0, roundsMax: 0, mergeMedianHours: 0 });
  });
});

describe("median и parseSince", () => {
  it("медиана чётного и нечётного списка", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it("--since: дата в UTC; по умолчанию сутки назад; мусор — ошибка", () => {
    const now = Date.parse("2026-11-14T12:00:00Z");
    expect(parseSince("2026-11-13", now)).toBe(Date.parse("2026-11-13T00:00:00Z"));
    expect(parseSince(undefined, now)).toBe(now - 24 * 3600 * 1000);
    expect(() => parseSince("вчера", now)).toThrow();
  });
});

describe("renderReport: Markdown для чата", () => {
  it("содержит доли, круги, топ-5 файлов конфликтов и пачки", () => {
    const pr = prStats([
      { number: 1, createdAt: T("08"), mergedAt: T("10"), reworkLabels: 0, reworkComments: 0 },
      { number: 2, createdAt: T("08"), mergedAt: T("12"), reworkLabels: 2, reworkComments: 0 },
    ]);
    const files = ["a", "a", "a", "b", "b", "c", "d", "e", "f"];
    const train = parseTrainLog(
      log(
        `${T("10")} не влит #1: конфликт с dev: ${files.join(" ")}`,
        `${T("11")} не влит #2: свой CI красный: gate=RED check=GREEN`,
        `${T("12")} сеть: fetch не прошёл`,
        `${T("13")} пачка 1 2: проверка в #9`,
      ),
      Date.parse(T("00")),
    );
    const md = renderReport({ pr, train, since: "2026-11-13" });
    expect(md).toContain("С первого ревью — 50 %");
    expect(md).toContain("максимум 2");
    expect(md).toContain("конфликт — 1");
    expect(md).toContain("a — 3");
    expect(md).not.toContain("f — 1");
    expect(md).toContain("красный CI — 1");
    expect(md).toContain("сеть — 1");
    expect(md).toContain("Пачек — 1");
  });
});
