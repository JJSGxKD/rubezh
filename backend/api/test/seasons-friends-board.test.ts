import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SeasonBoardStore } from "../src/modules/seasons/season-board.store.js";
import { SeasonSchedule } from "../src/modules/seasons/seasons-schedule.js";
import { SeasonsViewService } from "../src/modules/seasons/seasons-view.service.js";
import type { SeasonsRepository } from "../src/modules/seasons/seasons.repository.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Доска друзей недели (T-0448, Р213): ответ несёт число принятых друзей, чтобы
 * экран отличал «друзей нет» от «друзья ещё не играли на этой неделе».
 */

const at = new Date("2026-11-04T12:00:00Z");

function viewOf(friendIds: string[], played: Map<string, number>) {
  const schedule = new SeasonSchedule(panelSettings({ [SETTINGS.seasonsStartDate.key]: 20261102 }));
  const rating = { boardOf: async () => "common" as const };
  const restrictions = { status: async () => null };
  const friends = { friends: async () => friendIds.map((accountId) => ({ accountId })) };
  const store = {
    scores: async (_key: string, _difficulty: string, ids: string[]) => new Map(ids.filter((id) => played.has(id)).map((id) => [id, played.get(id) ?? 0])),
    top: async () => [...played.entries()].map(([accountId, score]) => ({ accountId, score })),
    count: async () => played.size,
    rank: async () => 1,
    best: async () => 100,
  };
  const repository = {
    boardRuns: async (ids: string[]) =>
      ids
        .filter((id) => played.has(id))
        .map((accountId) => ({ runId: randomUUID(), accountId, displayName: "Игрок", photoUrl: null, tester: false, supporter: false, points: null, survivalSec: played.get(accountId) ?? 0, style: null, level: 3, startingWeaponId: "spark", enemiesKilled: 10 })),
  };
  return new SeasonsViewService(schedule, repository as unknown as SeasonsRepository, store as unknown as SeasonBoardStore, friends as never, restrictions as never, rating as never);
}

describe("SeasonsViewService.board: число друзей", () => {
  it("два друга без забега недели, у игрока забег есть: одна строка и friendCount 2", async () => {
    const me = randomUUID();
    const view = viewOf([randomUUID(), randomUUID()], new Map([[me, 100]]));

    const board = await view.board(me, { difficulty: "hard", scope: "friends" }, at);

    expect(board.entries).toHaveLength(1);
    expect(board.entries[0]?.isMe).toBe(true);
    expect(board.friendCount).toBe(2);
  });

  it("друзей нет: friendCount 0", async () => {
    const me = randomUUID();
    const board = await viewOf([], new Map([[me, 100]])).board(me, { difficulty: "hard", scope: "friends" }, at);

    expect(board.friendCount).toBe(0);
  });

  it("друг с забегом недели: две строки и friendCount 1", async () => {
    const me = randomUUID();
    const friend = randomUUID();
    const board = await viewOf([friend], new Map([[me, 100], [friend, 200]])).board(me, { difficulty: "hard", scope: "friends" }, at);

    expect(board.entries).toHaveLength(2);
    expect(board.friendCount).toBe(1);
  });

  it("общая таблица: поля friendCount нет", async () => {
    const me = randomUUID();
    const board = await viewOf([randomUUID()], new Map([[me, 100]])).board(me, { difficulty: "hard", scope: "all" }, at);

    expect("friendCount" in board).toBe(false);
  });
});
