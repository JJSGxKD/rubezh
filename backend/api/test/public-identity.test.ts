import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { PUBLIC_IDENTITY_TIMEOUT_MS, PublicIdentity, type PublicMark } from "../src/common/public-identity.js";
import { AuthHooks } from "../src/modules/auth/auth-hooks.js";
import { FriendsService } from "../src/modules/friends/friends.service.js";
import type { FriendNotifier } from "../src/modules/friends/friend-notifier.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import type { RunFinish } from "../src/modules/runs/dto/runs.dto.js";
import { RunContinues } from "../src/modules/runs/run-continues.js";
import { RunExtras } from "../src/modules/runs/run-details.js";
import { RunLoadouts } from "../src/modules/runs/run-loadouts.js";
import { RunPrestige } from "../src/modules/runs/run-prestige.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { RunsViewService } from "../src/modules/runs/runs-view.service.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import type { SeasonBoardStore } from "../src/modules/seasons/season-board.store.js";
import { SeasonSchedule } from "../src/modules/seasons/seasons-schedule.js";
import { SeasonsViewService } from "../src/modules/seasons/seasons-view.service.js";
import type { SeasonsRepository } from "../src/modules/seasons/seasons.repository.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import type { WalletService } from "../src/modules/wallet/wallet.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryFriendsRepository } from "./helpers/memory-friends.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryLeaderboardStore, MemoryRunsRepository, ratingRestrictions, survivalScorer } from "./helpers/memory-runs.js";
import { memoryNotifications } from "./helpers/memory-notifications.js";
import { MemoryRestrictionsRepository, restrictionsGate } from "./helpers/memory-restrictions.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Один порт знака у имени для строк списков (tasks/T-0240, docs/35-stage4-plan.md Р149):
 * рейтинг, таблица сезона и друзья берут знак через `PublicIdentity` одним вызовом на
 * список и не знают, откуда он. Сбой источника список не роняет.
 */

const config = () => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);

const LAST_RUBEZH: PublicMark = { emblem: { id: "emb_season_champion", title: "Чемпион", tier: "mythic", category: "season", season: 3 } };
const TESTER: PublicMark = { emblem: { id: "emb_tester", title: "Тестер", tier: "rare", category: "status" } };

/** Источник из словаря с журналом вызовов; кого в словаре нет — того нет и в карте. */
function source(marks: Record<string, PublicMark>) {
  const calls: string[][] = [];
  return {
    calls,
    async of(ids: readonly string[]) {
      calls.push([...ids]);
      return new Map(ids.flatMap((id) => (marks[id] === undefined ? [] : [[id, marks[id]] as const])));
    },
  };
}

beforeEach(() => {
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("порт PublicIdentity", () => {
  it("без источника — пустая карта", async () => {
    const identity = new PublicIdentity();

    expect((await identity.of([randomUUID()])).size).toBe(0);
  });

  it("источник бросил — пустая карта и запись public_identity_failed в лог", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const identity = new PublicIdentity();
    identity.provide({
      async of() {
        throw new Error("база знаков недоступна");
      },
    });

    const marks = await identity.of([randomUUID()]);

    expect(marks.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("public_identity_failed");
  });

  it("источник завис дольше таймаута — пустая карта", async () => {
    const identity = new PublicIdentity();
    identity.provide({ of: () => new Promise<Map<string, PublicMark>>(() => undefined) });
    vi.useFakeTimers();

    const pending = identity.of([randomUUID()]);
    await vi.advanceTimersByTimeAsync(PUBLIC_IDENTITY_TIMEOUT_MS + 1);

    expect((await pending).size).toBe(0);
  });

  it("таймаут — одна секунда", () => {
    expect(PUBLIC_IDENTITY_TIMEOUT_MS).toBe(1_000);
  });

  it("пустой список источник не зовёт", async () => {
    const spy = source({});
    const identity = new PublicIdentity();
    identity.provide(spy);

    expect((await identity.of([])).size).toBe(0);
    expect(spy.calls).toHaveLength(0);
  });

  it("отдаёт знаки источника только тем, кого спросили, и только знак: чужие id и лишние поля отброшены", async () => {
    const asked = randomUUID();
    const stranger = randomUUID();
    const identity = new PublicIdentity();
    identity.provide({
      async of() {
        return new Map<string, PublicMark>([
          [asked, { ...LAST_RUBEZH, extra: "лишнее" } as PublicMark],
          [stranger, TESTER],
        ]);
      },
    });

    const marks = await identity.of([asked]);

    expect([...marks.keys()]).toEqual([asked]);
    expect(marks.get(asked)).toEqual(LAST_RUBEZH);
  });

  it("повторные id в списке уходят источнику один раз", async () => {
    const id = randomUUID();
    const spy = source({ [id]: TESTER });
    const identity = new PublicIdentity();
    identity.provide(spy);

    await identity.of([id, id, id]);

    expect(spy.calls).toEqual([[id]]);
  });
});

describe("рейтинг", () => {
  let accounts: MemoryAccountRepository;
  let runs: MemoryRunsRepository;
  let service: RunsService;
  let identity: PublicIdentity;
  let view: RunsViewService;

  function finish(survivalSec: number): RunFinish {
    return {
      runId: randomUUID(),
      difficultyId: "hard",
      outcome: "died",
      survivalSec,
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
    };
  }

  async function player(survivalSec: number): Promise<AccountRef> {
    const account = await accounts.upsert({ platform: "telegram", platformUserId: String(Math.floor(Math.random() * 1e9)), displayName: "Игрок", username: null, photoUrl: null }, Date.now());
    const ref = { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
    await service.finish(ref, finish(survivalSec));
    return ref;
  }

  beforeEach(() => {
    accounts = new MemoryAccountRepository();
    runs = new MemoryRunsRepository();
    const board = new MemoryLeaderboardStore();
    const rating = ratingRestrictions(runs, board);
    const roles = new RolesService(config(), new MemoryRolesRepository(), accounts);
    service = new RunsService(config(), runs, board, roles, new RunsHooks(), new RunContinues(), new RunLoadouts(), rating.rating, undefined, survivalScorer());
    identity = new PublicIdentity();
    view = new RunsViewService(runs, board, new RunExtras(), rating.rating, new RunPrestige(), undefined, identity);
  });

  it("каждая строка несёт знак своего игрока; без знака у источника — поля emblem нет", async () => {
    const [leader, second, third] = [await player(600), await player(300), await player(200)];
    identity.provide(source({ [leader.accountId]: LAST_RUBEZH, [second.accountId]: TESTER }));

    const board = await view.leaderboardFor(leader.accountId, "hard");

    expect(board.entries.map((entry) => entry.emblem?.id ?? null)).toEqual(["emb_season_champion", "emb_tester", null]);
    expect("emblem" in (board.entries[2] ?? {})).toBe(false);
    expect(third.accountId).not.toBe(leader.accountId);
  });

  it("на таблицу — один вызов источника со всеми id строк", async () => {
    const players = [await player(600), await player(300), await player(200), await player(100)];
    const spy = source({});
    identity.provide(spy);

    await view.leaderboardFor(players[0]?.accountId ?? "", "hard");

    expect(spy.calls).toHaveLength(1);
    expect([...(spy.calls[0] ?? [])].sort()).toEqual(players.map((entry) => entry.accountId).sort());
  });

  it("поля tester и supporter остаются рядом со знаком", async () => {
    const leader = await player(600);
    const bestRuns = runs.bestRuns.bind(runs);
    vi.spyOn(runs, "bestRuns").mockImplementation(async (...args) => (await bestRuns(...args)).map((row) => ({ ...row, tester: true, supporter: true })));
    identity.provide(source({ [leader.accountId]: TESTER }));

    const board = await view.leaderboardFor(leader.accountId, "hard");

    expect(board.entries[0]).toMatchObject({ tester: true, supporter: true, emblem: { id: "emb_tester" } });
  });

  it("порта нет, источник упал или завис — таблица отдана, строки без знака", async () => {
    const leader = await player(600);
    await player(300);

    const withoutSource = await view.leaderboardFor(leader.accountId, "hard");
    identity.provide({
      async of() {
        throw new Error("сбой");
      },
    });
    const failed = await view.leaderboardFor(leader.accountId, "hard");
    identity.provide({ of: () => new Promise<Map<string, PublicMark>>(() => undefined) });
    vi.useFakeTimers();
    const pending = view.leaderboardFor(leader.accountId, "hard");
    await vi.advanceTimersByTimeAsync(PUBLIC_IDENTITY_TIMEOUT_MS + 1);
    const hung = await pending;

    for (const seen of [withoutSource, failed, hung]) {
      expect(seen.entries).toHaveLength(2);
      for (const entry of seen.entries) expect("emblem" in entry).toBe(false);
    }
  });

  it("вид без порта вовсе (старый состав модуля) — таблица без знаков", async () => {
    const leader = await player(600);
    const board = new MemoryLeaderboardStore();
    const bare = new RunsViewService(runs, board, new RunExtras(), ratingRestrictions(runs, board).rating, new RunPrestige());

    const seen = await bare.leaderboardFor(leader.accountId, "hard");

    for (const entry of seen.entries) expect("emblem" in entry).toBe(false);
  });
});

describe("таблица сезона", () => {
  const at = new Date("2026-11-04T12:00:00Z");

  function viewOf(identity: PublicIdentity, ids: string[]) {
    const schedule = new SeasonSchedule(panelSettings({ [SETTINGS.seasonsStartDate.key]: 20261102 }));
    const store = {
      top: async () => ids.map((accountId, index) => ({ accountId, score: 100 - index })),
      count: async () => ids.length,
      rank: async () => 1,
      best: async () => 100,
    };
    const repository = {
      boardRuns: async (rowIds: string[]) =>
        rowIds.map((accountId) => ({ runId: randomUUID(), accountId, displayName: "Игрок", photoUrl: null, tester: true, supporter: true, points: 90, survivalSec: 100, style: null, level: 3, startingWeaponId: "spark", enemiesKilled: 10 })),
    };
    const rating = { boardOf: async () => "common" as const };
    const restrictions = { status: async () => null };
    return new SeasonsViewService(schedule, repository as unknown as SeasonsRepository, store as unknown as SeasonBoardStore, {} as never, restrictions as never, rating as never, identity);
  }

  it("строки несут знак, поля tester и supporter на месте, источник зван один раз на таблицу", async () => {
    const [me, other, plain] = [randomUUID(), randomUUID(), randomUUID()];
    const spy = source({ [me]: LAST_RUBEZH, [other]: TESTER });
    const identity = new PublicIdentity();
    identity.provide(spy);

    const board = await viewOf(identity, [me, other, plain]).board(me, { difficulty: "hard", scope: "all" }, at);

    expect(board.entries.map((entry) => entry.emblem?.id ?? null)).toEqual(["emb_season_champion", "emb_tester", null]);
    expect(board.entries[0]?.emblem?.season).toBe(3);
    expect(board.entries.every((entry) => entry.tester === true && entry.supporter === true)).toBe(true);
    expect(spy.calls).toHaveLength(1);
  });

  it("источник упал — таблица отдана без знаков", async () => {
    const me = randomUUID();
    const identity = new PublicIdentity();
    identity.provide({
      async of() {
        throw new Error("сбой");
      },
    });

    const board = await viewOf(identity, [me, randomUUID()]).board(me, { difficulty: "hard", scope: "all" }, at);

    expect(board.entries).toHaveLength(2);
    for (const entry of board.entries) expect("emblem" in entry).toBe(false);
  });
});

describe("друзья", () => {
  let accounts: MemoryAccountRepository;
  let repository: MemoryFriendsRepository;
  let identity: PublicIdentity;
  let service: FriendsService;

  async function player(id: string) {
    return await accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Игрок ${id}`, username: null, photoUrl: null }, Date.now());
  }

  beforeEach(() => {
    accounts = new MemoryAccountRepository();
    repository = new MemoryFriendsRepository(accounts);
    identity = new PublicIdentity();
    const notifier = { requestSent: async () => "sent" as const } as unknown as FriendNotifier;
    service = new FriendsService(config(), repository, accounts, new AuthHooks(), {} as unknown as WalletService, notifier, memoryNotifications().service, restrictionsGate(new MemoryRestrictionsRepository()), identity);
  });

  it("друг несёт знак одним вызовом на весь список", async () => {
    const [me, first, second] = [await player("1"), await player("2"), await player("3")];
    await repository.befriend(me.accountId, first.accountId, "request", 50);
    await repository.befriend(me.accountId, second.accountId, "request", 50);
    const spy = source({ [first.accountId]: LAST_RUBEZH });
    identity.provide(spy);

    const seen = await service.view(me.accountId);

    expect(seen.friends).toHaveLength(2);
    expect(seen.friends.find((friend) => friend.accountId === first.accountId)?.emblem?.id).toBe("emb_season_champion");
    expect("emblem" in (seen.friends.find((friend) => friend.accountId === second.accountId) ?? {})).toBe(false);
    expect(spy.calls).toHaveLength(1);
  });

  it("источник упал — список друзей отдан без знаков", async () => {
    const [me, friend] = [await player("1"), await player("2")];
    await repository.befriend(me.accountId, friend.accountId, "request", 50);
    identity.provide({
      async of() {
        throw new Error("сбой");
      },
    });

    const seen = await service.view(me.accountId);

    expect(seen.friends).toHaveLength(1);
    expect("emblem" in (seen.friends[0] ?? {})).toBe(false);
  });
});
