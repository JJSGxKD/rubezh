import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { funnelReportSchema, markedFunnelRow, touchOf, type FunnelRow } from "../src/api/funnel";
import { BOARD_MARK_LABEL, boardMarkShare, overviewSchema } from "../src/api/overview";
import { reviewRowSchema } from "../src/api/review";
import { BoardMarkPanel } from "../src/screens/overview/overview-parts";
import { BoardMarkBadge } from "../src/screens/review/review-parts";

/**
 * Метка «Отдельная доска» в панели (T-0115): блок сводки, строка воронки и
 * значок на разборе есть при данных и пропадают без них — без права сервер
 * присылает `null` или не присылает поле, и места под блок не остаётся.
 */

const DAY = {
  accounts: {},
  active: 40,
  sessions: 90,
  runs: { finished: 120, players: 30, medianSurvivalSec: 410 },
  revenue: null,
  funnel: { entered: 10, appOpened: 9, firstRun: 8, runs5: 2, returnedD1: 5, returnedD7: 1, firstPurchase: 1 },
};
const OVERVIEW = { day: "2026-10-01", from: "2026-09-30T21:00:00.000Z", at: "2026-10-01T18:30:00.000Z", today: DAY, yesterday: DAY, series: [], attention: [] };
const MARK = { today: { marked: 5, active: 4, newAccounts: 1, runs: 30 }, yesterday: { marked: 5, active: 3, newAccounts: 0, runs: 12 } };

const ROW: FunnelRow = { platform: "telegram", startKind: "organic", startRef: null, startSource: null, accounts: 40, entered: 32, appOpened: 38, firstRunStarted: 30, firstRunFinished: 25, runs2: 20, runs5: 9, returnedD1: 12, returnedD7: 4, firstPurchase: 1 };
const MARKED = { accounts: 3, entered: 3, appOpened: 3, firstRunStarted: 2, firstRunFinished: 2, runs2: 1, runs5: 0, returnedD1: 1, returnedD7: 0, firstPurchase: 0 };

describe("сводка", () => {
  it("метка разбирается, а без неё — null", () => {
    expect(overviewSchema.parse({ ...OVERVIEW, boardMark: MARK }).boardMark).toEqual(MARK);
    expect(overviewSchema.parse(OVERVIEW).boardMark).toBeNull();
    expect(overviewSchema.parse({ ...OVERVIEW, boardMark: null }).boardMark).toBeNull();
  });

  it("блок показывает сегодня и вчера и долю забегов; без метки блока нет", () => {
    const html = renderToStaticMarkup(createElement(BoardMarkPanel, { mark: MARK, today: DAY }));
    expect(html).toContain(BOARD_MARK_LABEL);
    expect(html).toContain("вчера");
    expect(html).toContain("25%");
    expect(renderToStaticMarkup(createElement(BoardMarkPanel, { mark: null, today: DAY }))).toBe("");
  });

  it("доля забегов — от всех завершённых, ноль забегов — без доли", () => {
    expect(boardMarkShare(MARK.today, DAY)).toBe(25);
    expect(boardMarkShare({ ...MARK.today, runs: 0 }, { ...DAY, runs: { ...DAY.runs, finished: 0 } })).toBeNull();
  });

  it("подпись нейтральная", () => {
    expect(BOARD_MARK_LABEL).toBe("Отдельная доска");
    expect(BOARD_MARK_LABEL).not.toMatch(/читер|нарушител|контур|изоляц/i);
  });
});

describe("воронка", () => {
  it("строка помеченных — последняя, с подписью «все источники»; без `marked` строки нет", () => {
    const report = funnelReportSchema.parse({ from: "a", to: "b", rows: [ROW], marked: MARKED });
    const row = markedFunnelRow(report);
    expect(row).toMatchObject({ accounts: 3, entered: 3, firstRunStarted: 2 });
    expect(row && touchOf(row).title).toBe(`${BOARD_MARK_LABEL} (все источники)`);
    expect(markedFunnelRow(funnelReportSchema.parse({ from: "a", to: "b", rows: [ROW] }))).toBeNull();
  });
});

describe("разбор забегов", () => {
  const run = { runId: "r1", accountId: "a1", displayName: "Вера", verdict: "suspicious", verdictReasons: [], difficulty: "easy", survivalSec: 60, level: 1, enemiesKilled: 1, finishedAt: null };

  it("значок есть у помеченного и пропадает без поля или с false", () => {
    expect(renderToStaticMarkup(createElement(BoardMarkBadge, { run: reviewRowSchema.parse({ ...run, boardMarked: true }) }))).toContain(BOARD_MARK_LABEL);
    expect(renderToStaticMarkup(createElement(BoardMarkBadge, { run: reviewRowSchema.parse({ ...run, boardMarked: false }) }))).toBe("");
    expect(renderToStaticMarkup(createElement(BoardMarkBadge, { run: reviewRowSchema.parse(run) }))).toBe("");
  });
});
