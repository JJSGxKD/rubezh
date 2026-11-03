import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import type { RunFinish } from "../src/modules/runs/dto/runs.dto.js";
import { RunContinues } from "../src/modules/runs/run-continues.js";
import { RunExtras } from "../src/modules/runs/run-details.js";
import { RunLoadouts } from "../src/modules/runs/run-loadouts.js";
import { PRESTIGE_TIMEOUT_MS, RunPrestige, type PrestigeSource } from "../src/modules/runs/run-prestige.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { RunsViewService } from "../src/modules/runs/runs-view.service.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryLeaderboardStore, MemoryRunsRepository, ratingRestrictions } from "./helpers/memory-runs.js";

/**
 * Престиж в строках рейтинга (tasks/T-0107, docs/39-retention-mechanics.md К1).
 * Модуль забегов о достижениях не знает: источник подключают достижения через
 * порт `RunPrestige`, как модуль предметов подключает сверку снаряжения.
 * Проверяется то, на чём рейтинг мог бы сломаться: один запрос на всю таблицу,
 * отсутствие источника, упавший и зависший источник, чужие id в ответе.
 */

const config = () => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);

function finish(patch: Partial<RunFinish> = {}): RunFinish {
  return {
    runId: randomUUID(),
    difficultyId: "hard",
    outcome: "died",
    survivalSec: 120,
    level: 6,
    enemiesKilled: 300,
    startingWeaponId: "knife",
    weapons: [{ id: "knife", level: 2 }],
    contentHash: "abc",
    deathCause: "swarm_rat",
    cheats: false,
    countInRating: false,
    continues: [],
    boosts: [],
    passives: [],
    ...patch,
  };
}

let accounts: MemoryAccountRepository;
let runs: MemoryRunsRepository;
let board: MemoryLeaderboardStore;
let service: RunsService;
let prestige: RunPrestige;
let view: RunsViewService;

beforeEach(() => {
  accounts = new MemoryAccountRepository();
  runs = new MemoryRunsRepository();
  board = new MemoryLeaderboardStore();
  const rating = ratingRestrictions(runs, board);
  const roles = new RolesService(config(), new MemoryRolesRepository(), accounts);
  service = new RunsService(config(), runs, board, roles, new RunsHooks(), new RunContinues(), new RunLoadouts(), rating.rating);
  prestige = new RunPrestige();
  view = new RunsViewService(runs, board, new RunExtras(), rating.rating, prestige);
});

afterEach(() => {
  vi.useRealTimers();
});

async function player(name: string, survivalSec: number): Promise<AccountRef> {
  const account = await accounts.upsert({ platform: "telegram", platformUserId: String(Math.floor(Math.random() * 1e9)), displayName: name, username: null, photoUrl: null }, Date.now());
  const ref = { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
  await service.finish(ref, finish({ survivalSec }));
  return ref;
}

/** Источник из словаря с журналом вызовов; кого в словаре нет — того нет и в карте. */
function source(points: Record<string, number>): PrestigeSource & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async of(ids) {
      calls.push([...ids]);
      return new Map(ids.flatMap((id) => (points[id] === undefined ? [] : [[id, points[id]] as const])));
    },
  };
}

describe("престиж в строке рейтинга", () => {
  it("каждая строка несёт престиж своего игрока из источника; кого источник не назвал — ноль", async () => {
    const [leader, second, third] = [await player("Лидер", 600), await player("Второй", 300), await player("Третий", 200)];
    prestige.provide(source({ [leader.accountId]: 120, [second.accountId]: 15 }));

    const board = await view.leaderboardFor(leader.accountId, "hard");

    expect(board.entries.map((entry) => [entry.rank, entry.prestige])).toEqual([
      [1, 120],
      [2, 15],
      [3, 0],
    ]);
    expect(third.accountId).not.toBe(leader.accountId);
  });

  it("источник вызван один раз на всю таблицу, со всеми id топа", async () => {
    const players = [await player("А", 600), await player("Б", 300), await player("В", 200), await player("Г", 100)];
    const spy = source({});
    prestige.provide(spy);

    await view.leaderboardFor(players[0]?.accountId ?? "", "hard");

    expect(spy.calls).toHaveLength(1);
    expect([...(spy.calls[0] ?? [])].sort()).toEqual(players.map((entry) => entry.accountId).sort());
  });

  it("пустая таблица источник не зовёт", async () => {
    const spy = source({});
    prestige.provide(spy);

    const empty = await view.leaderboardFor(randomUUID(), "hard");

    expect(empty.entries).toEqual([]);
    expect(spy.calls).toHaveLength(0);
  });

  it("источника нет — у всех ноль, таблица отдана", async () => {
    const [leader] = [await player("Лидер", 600), await player("Второй", 300)];

    const seen = await view.leaderboardFor(leader.accountId, "hard");

    expect(seen.entries.map((entry) => entry.prestige)).toEqual([0, 0]);
    expect(seen.entries).toHaveLength(2);
  });

  it("источник упал — у всех ноль, таблица отдана", async () => {
    const [leader] = [await player("Лидер", 600), await player("Второй", 300)];
    prestige.provide({
      async of() {
        throw new Error("база достижений недоступна");
      },
    });

    const seen = await view.leaderboardFor(leader.accountId, "hard");

    expect(seen.entries.map((entry) => [entry.rank, entry.prestige])).toEqual([
      [1, 0],
      [2, 0],
    ]);
  });

  it("источник завис — по таймауту у всех ноль, таблица отдана", async () => {
    const [leader] = [await player("Лидер", 600), await player("Второй", 300)];
    prestige.provide({ of: () => new Promise<Map<string, number>>(() => undefined) });
    vi.useFakeTimers();

    const pending = view.leaderboardFor(leader.accountId, "hard");
    await vi.advanceTimersByTimeAsync(PRESTIGE_TIMEOUT_MS + 1);
    const seen = await pending;

    expect(seen.entries.map((entry) => entry.prestige)).toEqual([0, 0]);
  });

  it("отрицательное и нечисловое от источника — ноль: значок не рисуется", async () => {
    const [leader, second] = [await player("Лидер", 600), await player("Второй", 300)];
    prestige.provide({
      async of() {
        return new Map<string, number>([
          [leader.accountId, -5],
          [second.accountId, Number.NaN],
        ]);
      },
    });

    const seen = await view.leaderboardFor(leader.accountId, "hard");

    expect(seen.entries.map((entry) => entry.prestige)).toEqual([0, 0]);
  });

  it("в строке нет идентификатора аккаунта: наружу уходит только «моя» ли это строка", async () => {
    const [leader, second] = [await player("Лидер", 600), await player("Второй", 300)];
    prestige.provide(source({ [leader.accountId]: 7 }));

    const seen = await view.leaderboardFor(second.accountId, "hard");
    const text = JSON.stringify(seen);

    expect(text).not.toContain(leader.accountId);
    expect(text).not.toContain(second.accountId);
    for (const entry of seen.entries) expect(Object.keys(entry)).not.toContain("accountId");
    expect(seen.entries.map((entry) => entry.isMe)).toEqual([false, true]);
  });
});
