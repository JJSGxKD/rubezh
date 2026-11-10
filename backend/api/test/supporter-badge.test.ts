import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { RunPrestige } from "../src/modules/runs/run-prestige.js";
import { RunsViewService } from "../src/modules/runs/runs-view.service.js";
import { PrismaRunsRepository, type BestRunRow } from "../src/modules/runs/runs.repository.js";
import type { SeasonBoardStore } from "../src/modules/seasons/season-board.store.js";
import { seasonOf } from "../src/modules/seasons/season-rules.js";
import { SeasonSchedule } from "../src/modules/seasons/seasons-schedule.js";
import { SeasonsViewService } from "../src/modules/seasons/seasons-view.service.js";
import { PrismaSeasonsRepository, type SeasonsRepository } from "../src/modules/seasons/seasons.repository.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Знак «Меценат» в рейтинге и таблице сезона (T-0161, Р109): строка несёт
 * `supporter: true` только у поддержавшего, а дата знака наружу не уходит.
 * Вход проверяет `auth.test.ts`, живую базу — `runs.integration.test.ts`.
 */

const ME = randomUUID();
const PATRON = randomUUID();
const STRANGER = randomUUID();

function best(accountId: string, patch: Partial<BestRunRow> = {}): BestRunRow {
  return { accountId, displayName: `Игрок ${accountId.slice(0, 4)}`, photoUrl: null, survivalSec: 300, points: 300, style: null, level: 7, startingWeaponId: "knife", enemiesKilled: 90, ...patch };
}

describe("знак «Меценат» в рейтинге", () => {
  function viewOf(rows: BestRunRow[], options: { shadow?: BestRunRow | null; hold?: "silent" | null } = {}): RunsViewService {
    const runs = { bestRuns: async () => rows, bestRunOf: async () => options.shadow ?? null };
    const leaderboard = {
      top: async () => rows.map((row) => ({ accountId: row.accountId, survivalSec: row.survivalSec })),
      count: async () => rows.length,
      rank: async () => 1,
      best: async () => 300,
      countAbove: async () => 0,
    };
    const rating = { hold: async () => options.hold ?? null, boardOf: async () => "common" as const, since: () => null };
    return new RunsViewService(runs as never, leaderboard as never, {} as never, rating as never, new RunPrestige());
  }

  it("у поддержавшего в строке доски supporter: true, у остальных поля нет вовсе", async () => {
    const { entries } = await viewOf([best(PATRON, { supporter: true }), best(STRANGER)]).leaderboardFor(ME, "hard");

    expect(entries[0]).toMatchObject({ supporter: true });
    expect(entries[1]).not.toHaveProperty("supporter");
    expect(entries[0]).not.toHaveProperty("supporterAt");
  });

  it("знаки тестера и мецената в строке независимы", async () => {
    const { entries } = await viewOf([best(PATRON, { supporter: true, tester: true }), best(STRANGER, { tester: true })]).leaderboardFor(ME, "hard");

    expect(entries[0]).toMatchObject({ tester: true, supporter: true });
    expect(entries[1]).toMatchObject({ tester: true });
    expect(entries[1]).not.toHaveProperty("supporter");
  });

  it("игрок в тени видит себя со знаком, если он поддержал проект, и без знака — если нет", async () => {
    const withSign = await viewOf([best(STRANGER)], { shadow: best(ME, { supporter: true, survivalSec: 500 }), hold: "silent" }).leaderboardFor(ME, "hard");
    const without = await viewOf([best(STRANGER)], { shadow: best(ME, { survivalSec: 500 }), hold: "silent" }).leaderboardFor(ME, "hard");

    expect(withSign.entries.find((entry) => entry.isMe)).toMatchObject({ supporter: true });
    expect(without.entries.find((entry) => entry.isMe)).not.toHaveProperty("supporter");
  });
});

describe("знак «Меценат» в таблице сезона", () => {
  const at = new Date("2026-11-04T12:00:00Z");

  function viewOf(rows: BestRunRow[]): SeasonsViewService {
    const schedule = new SeasonSchedule(panelSettings({ [SETTINGS.seasonsStartDate.key]: 20261102 }));
    const repository = { boardRuns: async () => rows };
    const store = {
      top: async () => rows.map((row) => ({ accountId: row.accountId, score: row.survivalSec })),
      count: async () => rows.length,
      rank: async () => 1,
      best: async () => 300,
    };
    const rating = { boardOf: async () => "common" as const };
    const restrictions = { status: async () => null };
    return new SeasonsViewService(schedule, repository as unknown as SeasonsRepository, store as unknown as SeasonBoardStore, {} as never, restrictions as never, rating as never);
  }

  it("в строке таблицы supporter: true только у поддержавшего, даты знака нет", async () => {
    const view = await viewOf([best(PATRON, { supporter: true }), best(STRANGER)]).board(ME, { difficulty: "hard", scope: "all" }, at);

    expect(view.entries[0]).toMatchObject({ supporter: true });
    expect(view.entries[1]).not.toHaveProperty("supporter");
    for (const entry of view.entries) expect(entry).not.toHaveProperty("supporterAt");
  });
});

describe("выборка знака «Меценат» из базы", () => {
  const accountRow = (supporterAt: Date | null) => ({ displayName: "Игрок", photoUrl: null, testerAt: null, supporterAt });
  const runRow = (accountId: string, supporterAt: Date | null) => ({ accountId, survivalSec: 100, points: 100, style: null, level: 3, startingWeaponId: "knife", enemiesKilled: 10, account: accountRow(supporterAt) });
  const SIGNED = new Date("2026-10-20T10:00:00Z");

  it("сезонный репозиторий просит supporterAt и отдаёт supporter: true только при дате", async () => {
    const selects: unknown[] = [];
    const prisma = {
      run: {
        findMany: async (args: { select: unknown }) => {
          selects.push(args.select);
          return [runRow(PATRON, SIGNED), runRow(STRANGER, null)];
        },
      },
    };

    const rows = await new PrismaSeasonsRepository(prisma as unknown as PrismaClient).boardRuns([PATRON, STRANGER], "hard", seasonOf(new Date("2026-11-04T12:00:00Z")), null);

    expect(selects[0]).toMatchObject({ account: { select: { supporterAt: true } } });
    expect(rows[0]).toMatchObject({ accountId: PATRON, supporter: true });
    expect(rows[1]).not.toHaveProperty("supporter");
    for (const row of rows) expect(row).not.toHaveProperty("supporterAt");
  });

  it("репозиторий рейтинга: bestRuns и bestRunOf — то же правило", async () => {
    const prisma = {
      run: {
        findMany: async () => [runRow(PATRON, SIGNED), runRow(STRANGER, null)],
        findFirst: async () => runRow(PATRON, SIGNED),
      },
    };
    const repository = new PrismaRunsRepository(prisma as unknown as PrismaClient);

    const rows = await repository.bestRuns([PATRON, STRANGER], "hard", null);

    expect(rows[0]).toMatchObject({ supporter: true });
    expect(rows[1]).not.toHaveProperty("supporter");
    expect(await repository.bestRunOf(PATRON, "hard", false, null)).toMatchObject({ supporter: true });
    for (const row of rows) expect(row).not.toHaveProperty("supporterAt");
  });
});
