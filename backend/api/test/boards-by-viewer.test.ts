import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { RestrictionsService } from "../src/modules/restrictions/restrictions.service.js";
import type { ImposeInput } from "../src/modules/restrictions/restriction-rules.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import type { RunFinish } from "../src/modules/runs/dto/runs.dto.js";
import { ALL_BOARDS } from "../src/modules/runs/leaderboard.store.js";
import { RunContinues } from "../src/modules/runs/run-continues.js";
import { RunExtras } from "../src/modules/runs/run-details.js";
import { RunLoadouts } from "../src/modules/runs/run-loadouts.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { RunsViewService, type LeaderboardView } from "../src/modules/runs/runs-view.service.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { WelcomeProgressRegistry } from "../src/platforms/telegram/welcome.command.js";
import { RunsWelcomeProgress } from "../src/platforms/telegram/welcome-progress.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryLeaderboardStore, MemoryRunsRepository, ratingRestrictions } from "./helpers/memory-runs.js";

/**
 * Доски рейтинга по зрителю (T-0113, Р104): аккаунт со скрытым ограничением
 * «Отдельная доска» читает полную доску, остальные — общую, где таких
 * аккаунтов нет. Места, профиль, размер доски и ответ на конец забега
 * считаются по доске смотрящего; форма ответов у всех одна.
 */

const config = () => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);

function finish(patch: Partial<RunFinish> = {}): RunFinish {
  return {
    runId: randomUUID(),
    difficultyId: "normal",
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

/** Мир теста: те же модули, что в проде, на памяти. Каждый вызов — чистый мир. */
function build() {
  const accounts = new MemoryAccountRepository();
  const runs = new MemoryRunsRepository();
  const board = new MemoryLeaderboardStore();
  const rating = ratingRestrictions(runs, board);
  const rolesRepository = new MemoryRolesRepository();
  const roles = new RolesService(config(), rolesRepository, accounts);
  const restrictions = new RestrictionsService(rating.restrictions, accounts, roles, rating.gate, rating.hooks);
  const service = new RunsService(config(), runs, board, roles, new RunsHooks(), new RunContinues(), new RunLoadouts(), rating.rating);
  const view = new RunsViewService(runs, board, new RunExtras(), rating.rating);
  return { accounts, runs, board, rating, rolesRepository, restrictions, service, view };
}

type World = ReturnType<typeof build>;

async function player(world: World, name: string): Promise<AccountRef> {
  const account = await world.accounts.upsert({ platform: "telegram", platformUserId: String(Math.floor(Math.random() * 1e9)), displayName: name, username: null, photoUrl: null }, Date.now());
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}

async function staff(world: World, role: "owner" | "moderator"): Promise<AccountRef> {
  const account = await player(world, role);
  await world.rolesRepository.grant(account.accountId, role, null);
  return account;
}

function hidden(patch: Partial<ImposeInput> = {}): ImposeInput {
  return { kinds: ["separate_board"], endsAt: null, reason: "leaderboard_cheat", comment: null, notify: false, ...patch };
}

function silent(): ImposeInput {
  return { kinds: ["leaderboard"], endsAt: null, reason: "leaderboard_cheat", comment: null, notify: false };
}

/** Структура JSON без значений: у двух зрителей она обязана совпадать. */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])];
  if (value === null) return "null";
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, inner]) => [key, shapeOf(inner)]));
  return typeof value;
}

function rows(view: LeaderboardView): [number, number, boolean][] {
  return view.entries.map((entry) => [entry.rank, entry.survivalSec, entry.isMe]);
}

/** Детерминированный генератор для наборов «20 seed». */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

describe("доска по зрителю", () => {
  it("обычному — общая доска из трёх, с ограничением — полная из пяти; место, «всего игроков» и isMe по доске зрителя", async () => {
    const world = build();
    const owner = await staff(world, "owner");
    const plain = [await player(world, "Шестьдесят"), await player(world, "Девяносто"), await player(world, "Сто двадцать")];
    for (const [index, seconds] of [60, 90, 120].entries()) await world.service.finish(plain[index] as AccountRef, finish({ survivalSec: seconds }));
    const [early, late] = [await player(world, "Наложено до забега"), await player(world, "Наложено после забега")];
    // Одно ограничение наложено до первого забега, другое — когда рекорд уже в досках.
    await world.restrictions.impose(owner, early.accountId, hidden());
    await world.service.finish(early, finish({ survivalSec: 100 }));
    await world.service.finish(late, finish({ survivalSec: 200 }));
    await world.restrictions.impose(owner, late.accountId, hidden());

    const middle = await world.view.leaderboardFor((plain[1] as AccountRef).accountId, "normal");
    expect(rows(middle)).toEqual([[1, 120, false], [2, 90, true], [3, 60, false]]);
    expect(middle.me).toEqual({ rank: 2, survivalSec: 90 });
    expect(middle.totalPlayers).toBe(3);

    const restricted = await world.view.leaderboardFor(early.accountId, "normal");
    expect(rows(restricted)).toEqual([[1, 200, false], [2, 120, false], [3, 100, true], [4, 90, false], [5, 60, false]]);
    expect(restricted.me).toEqual({ rank: 3, survivalSec: 100 });
    expect(restricted.totalPlayers).toBe(5);

    const other = await world.view.leaderboardFor(late.accountId, "normal");
    expect(rows(other)[0]).toEqual([1, 200, true]);
    expect(other.me).toEqual({ rank: 1, survivalSec: 200 });
  });

  it("место «как будто их нет»: на 20 наборах общая доска равна доске, посчитанной без аккаунтов с ограничением", async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const random = lcg(seed);
      const world = build();
      const owner = await staff(world, "owner");
      const count = 6 + Math.floor(random() * 5);
      // Попарно разные времена: ничьи место не определяют однозначно.
      const times = Array.from({ length: count }, (_, index) => 30 + index * 17 + Math.floor(random() * 10)).sort(() => random() - 0.5);
      const players: { account: AccountRef; seconds: number; separate: boolean }[] = [];
      for (const [index, seconds] of times.entries()) players.push({ account: await player(world, `Игрок ${index}`), seconds, separate: random() < 0.4 });
      for (const entry of players) {
        // Ограничение — то до забега, то после: итог доски один.
        if (entry.separate && random() < 0.5) await world.restrictions.impose(owner, entry.account.accountId, hidden());
        await world.service.finish(entry.account, finish({ survivalSec: entry.seconds }));
        if (entry.separate && (await world.rating.rating.boardOf(entry.account.accountId)) === "common") await world.restrictions.impose(owner, entry.account.accountId, hidden());
      }

      const plain = players.filter((entry) => !entry.separate);
      for (const viewer of players) {
        const crowd = viewer.separate ? players : plain;
        const seen = await world.view.leaderboardFor(viewer.account.accountId, "normal");
        const expectedRank = 1 + crowd.filter((entry) => entry.seconds > viewer.seconds).length;
        expect(seen.me, `seed ${seed}`).toEqual({ rank: expectedRank, survivalSec: viewer.seconds });
        expect(seen.totalPlayers, `seed ${seed}`).toBe(crowd.length);
        expect(seen.entries.map((entry) => entry.survivalSec), `seed ${seed}`).toEqual(crowd.map((entry) => entry.seconds).sort((left, right) => right - left));
        expect(seen.entries.filter((entry) => entry.isMe), `seed ${seed}`).toHaveLength(1);
        expect((await world.view.profile(viewer.account.accountId)).best.normal, `seed ${seed}`).toEqual({ survivalSec: viewer.seconds, rank: expectedRank });
      }
    }
  });

  it("форма ответа одинаковая: набор ключей JSON у обоих зрителей совпадает", async () => {
    const world = build();
    const owner = await staff(world, "owner");
    const [plain, separate] = [await player(world, "Обычный"), await player(world, "Отдельная")];
    await world.restrictions.impose(owner, separate.accountId, hidden());
    await world.service.finish(plain, finish({ survivalSec: 90 }));
    await world.service.finish(separate, finish({ survivalSec: 150 }));

    const [left, right] = [await world.view.leaderboardFor(plain.accountId, "normal"), await world.view.leaderboardFor(separate.accountId, "normal")];

    expect(shapeOf(left)).toEqual(shapeOf(right));
    expect(shapeOf(await world.view.profile(plain.accountId))).toEqual(shapeOf(await world.view.profile(separate.accountId)));
    // Ни поля «доска», ни пометок в ответе нет.
    expect(JSON.stringify([left, right])).not.toMatch(/board|full|common|separate/i);
  });

  it("профиль и размер доски — по доске владельца; для команды место такое же, как у владельца", async () => {
    const world = build();
    const owner = await staff(world, "owner");
    const [plain, other, separate] = [await player(world, "Обычный"), await player(world, "Другой"), await player(world, "Отдельная")];
    await world.restrictions.impose(owner, separate.accountId, hidden());
    await world.service.finish(plain, finish({ survivalSec: 100 }));
    await world.service.finish(other, finish({ survivalSec: 50 }));
    await world.service.finish(separate, finish({ survivalSec: 300 }));
    await world.service.finish(separate, finish({ survivalSec: 20, difficultyId: "easy" }));

    expect((await world.view.profile(plain.accountId)).best.normal).toEqual({ survivalSec: 100, rank: 1 });
    expect((await world.view.profile(separate.accountId)).best.normal).toEqual({ survivalSec: 300, rank: 1 });
    expect((await world.view.profile(separate.accountId)).best.easy).toEqual({ survivalSec: 20, rank: 1 });
    expect((await world.view.profile(other.accountId)).best.normal).toEqual({ survivalSec: 50, rank: 2 });
    // Команда видит место так, как видит владелец профиля: по доске аккаунта.
    expect((await world.view.profile(other.accountId, "team")).best.normal).toEqual({ survivalSec: 50, rank: 2 });
    expect((await world.view.profile(separate.accountId, "team")).best.normal).toEqual({ survivalSec: 300, rank: 1 });
    expect((await world.view.profile(separate.accountId, "team")).best).toEqual((await world.view.profile(separate.accountId)).best);

    expect(await world.view.boardSize(plain.accountId, "normal")).toBe(2);
    expect(await world.view.boardSize(separate.accountId, "normal")).toBe(3);
    expect(await world.view.boardSize(separate.accountId, "hard")).toBe(0);
  });

  it("«тень» вместе с ограничением: зритель видит себя на месте по полной доске, а в доске его нет", async () => {
    const world = build();
    const [owner, moderator] = [await staff(world, "owner"), await staff(world, "moderator")];
    const [top, second, viewer, below] = [await player(world, "Верхний"), await player(world, "Второй"), await player(world, "В тени"), await player(world, "Нижний")];
    await world.restrictions.impose(owner, second.accountId, hidden());
    await world.restrictions.impose(owner, below.accountId, hidden());
    await world.restrictions.impose(owner, viewer.accountId, hidden());
    await world.restrictions.impose(moderator, viewer.accountId, silent());
    await world.service.finish(top, finish({ survivalSec: 300 }));
    await world.service.finish(second, finish({ survivalSec: 290 }));
    await world.service.finish(below, finish({ survivalSec: 250 }));

    // Тень: забег принят «как рейтинговый», в доски не идёт; место — среди полной доски, а не общей.
    const result = await world.service.finish(viewer, finish({ survivalSec: 280 }));
    expect(result).toMatchObject({ recorded: true, bestSurvivalSec: 280, rank: 3 });
    expect(await world.board.best("normal", viewer.accountId, "full")).toBeNull();
    expect(await world.board.best("normal", viewer.accountId, "common")).toBeNull();

    const seen = await world.view.leaderboardFor(viewer.accountId, "normal");
    expect(rows(seen)).toEqual([[1, 300, false], [2, 290, false], [3, 280, true], [4, 250, false]]);
    expect(seen.me).toEqual({ rank: 3, survivalSec: 280 });
    expect(seen.totalPlayers).toBe(4);
    expect((await world.view.profile(viewer.accountId)).best.normal).toEqual({ survivalSec: 280, rank: 3 });
    expect(await world.view.boardSize(viewer.accountId, "normal")).toBe(4);

    // Другие его не видят: ни обычный игрок, ни владелец отдельной доски.
    const common = await world.view.leaderboardFor(top.accountId, "normal");
    expect(rows(common)).toEqual([[1, 300, true]]);
    expect(common.totalPlayers).toBe(1);
    expect(rows(await world.view.leaderboardFor(below.accountId, "normal")).map(([, seconds]) => seconds)).toEqual([300, 290, 250]);
  });

  it("ответ на конец забега — по доске: обычного не сдвигает забег аккаунта с ограничением, а тот видит и обычных", async () => {
    const world = build();
    const owner = await staff(world, "owner");
    const [plain, other, first, second] = [await player(world, "Обычный"), await player(world, "Второй обычный"), await player(world, "Отдельная"), await player(world, "Ещё отдельная")];
    await world.restrictions.impose(owner, first.accountId, hidden());
    await world.restrictions.impose(owner, second.accountId, hidden());

    expect(await world.service.finish(plain, finish({ survivalSec: 100 }))).toMatchObject({ rank: 1, isNewBest: true });
    expect(await world.service.finish(first, finish({ survivalSec: 500 }))).toMatchObject({ rank: 1, isNewBest: true, bestSurvivalSec: 500 });
    // Рекорд аккаунта с ограничением обычного не сдвинул: он остался первым в общей доске.
    expect(await world.service.finish(plain, finish({ survivalSec: 110 }))).toMatchObject({ rank: 1, isNewBest: true, bestSurvivalSec: 110 });
    // Аккаунт с ограничением ниже обычного видит его над собой.
    expect(await world.service.finish(second, finish({ survivalSec: 105 }))).toMatchObject({ rank: 3 });
    expect(await world.service.finish(other, finish({ survivalSec: 107 }))).toMatchObject({ rank: 2 });
  });

  it("setRanked: снятие рекорда аккаунта с ограничением правит полную доску и не трогает общую; обычного — обе", async () => {
    const world = build();
    const [owner, moderator] = [await staff(world, "owner"), await staff(world, "moderator")];
    const [plain, separate] = [await player(world, "Обычный"), await player(world, "Отдельная")];
    await world.restrictions.impose(owner, separate.accountId, hidden());
    const records = { plain: randomUUID(), separate: randomUUID() };
    await world.service.finish(plain, finish({ runId: records.plain, survivalSec: 300 }));
    await world.service.finish(plain, finish({ survivalSec: 100 }));
    await world.service.finish(separate, finish({ runId: records.separate, survivalSec: 400 }));
    await world.service.finish(separate, finish({ survivalSec: 150 }));

    await world.service.setRanked(moderator, records.separate, false, "рекорд без урона");
    expect(await world.board.best("normal", separate.accountId, "full")).toBe(150);
    expect(await world.board.best("normal", separate.accountId, "common")).toBeNull();
    expect(await world.board.best("normal", plain.accountId, "common")).toBe(300);

    await world.service.setRanked(moderator, records.plain, false, "рекорд без урона");
    expect(await world.board.best("normal", plain.accountId, "full")).toBe(100);
    expect(await world.board.best("normal", plain.accountId, "common")).toBe(100);

    // Вернуть — тем же правилом: лучший рейтинговый в доски, которые положены аккаунту.
    await world.service.setRanked(moderator, records.separate, true, "ошиблись");
    await world.service.setRanked(moderator, records.plain, true, "ошиблись");
    expect(await world.board.best("normal", separate.accountId, "full")).toBe(400);
    expect(await world.board.best("normal", separate.accountId, "common")).toBeNull();
    expect(await world.board.best("normal", plain.accountId, "full")).toBe(300);
    expect(await world.board.best("normal", plain.accountId, "common")).toBe(300);
  });

  it("пересборка по ограничениям спрашивает оба набора, и обе CLI-команды ходят через неё", () => {
    const sources = ["runs-rebuild-leaderboard.ts", "wipe.ts"].map((name) => readFileSync(fileURLToPath(new URL(`../src/cli/${name}`, import.meta.url)), "utf8"));
    for (const source of sources) {
      expect(source).toMatch(/rebuildForRestrictions\(/);
      // Прежнего вызова с одним набором исключений не осталось.
      expect(source).not.toMatch(/rebuildLeaderboard\(/);
    }
  });
});

describe("хранилище в памяти ведёт себя как Redis", () => {
  it("запись по списку досок, GT на каждой, независимые чтения, снятие и замена", async () => {
    const board = new MemoryLeaderboardStore();

    expect(await board.submit("normal", "a", 300, ["full"])).toEqual({ improved: true });
    expect(await board.best("normal", "a", "common")).toBeNull();
    expect(await board.submit("normal", "b", 200, ALL_BOARDS)).toEqual({ improved: true });
    expect(await board.submit("normal", "b", 150, ALL_BOARDS)).toEqual({ improved: false });
    expect(await board.submit("normal", "a", 300, ["full"])).toEqual({ improved: false });

    expect(await board.rank("normal", "b", "full")).toBe(2);
    expect(await board.rank("normal", "b", "common")).toBe(1);
    expect(await board.count("normal", "full")).toBe(2);
    expect(await board.count("normal", "common")).toBe(1);
    expect(await board.countAbove("normal", 250, "full")).toBe(1);
    expect(await board.countAbove("normal", 250, "common")).toBe(0);
    expect((await board.top("normal", 10, "full")).map((entry) => entry.accountId)).toEqual(["a", "b"]);

    expect(await board.remove(["b", "никого"], ["common"])).toBe(1);
    expect(await board.best("normal", "b", "full")).toBe(200);
    await board.set("normal", "b", 50, ["common"]);
    expect(await board.best("normal", "b", "common")).toBe(50);
    await board.set("normal", "b", null, ALL_BOARDS);
    expect(await board.best("normal", "b", "full")).toBeNull();

    await board.replace("normal", "full", [{ accountId: "z", survivalSec: 9 }]);
    expect((await board.top("normal", 10, "full")).map((entry) => entry.accountId)).toEqual(["z"]);
    expect(await board.count("normal", "common")).toBe(0);
  });
});

describe("карточка /start считает место по доске аккаунта", () => {
  it("рекорд, место и размер доски: обычный читает общую, аккаунт с отдельной доской — полную", async () => {
    const world = build();
    const progress = new RunsWelcomeProgress(new WelcomeProgressRegistry(), world.accounts, world.view);
    const people = new Map<string, { telegramId: string; seconds: number }>([
      ["fast", { telegramId: "101", seconds: 50 }],
      ["plain", { telegramId: "102", seconds: 100 }],
      ["separate", { telegramId: "103", seconds: 300 }],
    ]);
    for (const [name, person] of people) {
      const account = await world.accounts.upsert({ platform: "telegram", platformUserId: person.telegramId, displayName: name, username: null, photoUrl: null }, Date.now());
      if (name === "separate") world.rating.restrictions.restrict(account.accountId, "separate_board", { notify: false });
      await world.service.finish({ accountId: account.accountId, platform: "telegram", platformUserId: person.telegramId }, finish({ difficultyId: "hard", survivalSec: person.seconds }));
    }

    // Обычные: общая доска из двух, отдельная в неё не входит.
    expect(await progress.progress("102")).toEqual({ best: { difficulty: "hard", survivalSec: 100, rank: 1, total: 2 }, runs: 1 });
    expect(await progress.progress("101")).toEqual({ best: { difficulty: "hard", survivalSec: 50, rank: 2, total: 2 }, runs: 1 });
    // Аккаунт с отдельной доской: полная из трёх, он на первом месте.
    expect(await progress.progress("103")).toEqual({ best: { difficulty: "hard", survivalSec: 300, rank: 1, total: 3 }, runs: 1 });
  });
});
