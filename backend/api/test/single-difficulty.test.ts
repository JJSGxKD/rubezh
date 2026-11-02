import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { RunRankingConflictError, RunsService } from "../src/modules/runs/runs.service.js";
import { RunsViewService } from "../src/modules/runs/runs-view.service.js";
import type { RunFinish } from "../src/modules/runs/dto/runs.dto.js";
import { ALL_BOARDS, type Board, type LeaderboardStore } from "../src/modules/runs/leaderboard.store.js";
import { isRatedRun, ratedWhere, ratingSinceOf } from "../src/modules/runs/rated-runs.js";
import { RunContinues } from "../src/modules/runs/run-continues.js";
import { RunExtras } from "../src/modules/runs/run-details.js";
import { RunLoadouts } from "../src/modules/runs/run-loadouts.js";
import { RunPrestige } from "../src/modules/runs/run-prestige.js";
import { DIFFICULTIES, RATED_DIFFICULTIES, isRatedDifficulty, type Difficulty } from "../src/modules/runs/run-rules.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";
import type { RunFinishRecord, RunsRepository } from "../src/modules/runs/runs.repository.js";
import { DIFFICULTY_LEVEL_BONUS } from "../src/modules/items/item-catalog.js";
import { DIFFICULTY_REWARD_MUL, runReward } from "../src/modules/progress/progress-rules.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { SETTINGS, SETTING_LIST, type SettingDefinition } from "../src/modules/settings/setting-catalog.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryLeaderboardStore, MemoryRunsRepository, ratingRestrictions } from "./helpers/memory-runs.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Одна сложность на сервере (Р126, tasks/T-0191): рейтинг и сезоны считают
 * забеги единой сложности, законченные не раньше даты отсечки
 * `rating.since-date`. Всё остальное — принимается, оценивается и награждается,
 * но в доски не идёт.
 */

const config = (): AppConfig => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);
const SINCE_KEY = SETTINGS.ratingSinceDate.key;
/** 26 октября 2026, 00:00 UTC — значение ключа 20261026 */
const SINCE_MS = Date.UTC(2026, 9, 26);
const HOUR = 3_600_000;
const AFTER_MS = SINCE_MS + 3 * HOUR;

function account(): AccountRef {
  return { accountId: randomUUID(), platform: "telegram", platformUserId: String(Math.floor(Math.random() * 1e9)) };
}

function runOf(difficultyId: Difficulty, patch: Partial<RunFinish> = {}): RunFinish {
  return {
    runId: randomUUID(),
    difficultyId,
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

/** Запись из «прошлой жизни»: до задачи в рейтинг шли все сложности, и в базе лежат `ranked = true` у всех. */
function legacy(accountId: string, difficulty: Difficulty, survivalSec: number, finishedAtMs: number): RunFinishRecord {
  return {
    runId: randomUUID(),
    accountId,
    difficulty,
    startingWeaponId: "knife",
    contentHash: "abc",
    finishedAt: new Date(finishedAtMs),
    outcome: "died",
    survivalSec,
    level: 6,
    enemiesKilled: 300,
    weapons: [{ id: "knife", level: 2 }],
    details: null,
    deathCause: null,
    cheats: false,
    continues: [],
    ranked: true,
    ratingRestricted: null,
    verdict: "ok",
    verdictReasons: [],
  };
}

/** Хранилище, к которому нельзя обращаться: нерейтинговая сложность Redis не трогает. */
function untouchable<T extends object>(name: string): T {
  return new Proxy({}, { get: (_target, method) => () => Promise.reject(new Error(`${name}.${String(method)} не должен вызываться`)) }) as T;
}

function world(since: number | null = 20261026) {
  const runs = new MemoryRunsRepository();
  const board = new MemoryLeaderboardStore();
  const settings = panelSettings(since === null ? {} : { [SINCE_KEY]: since });
  const rating = ratingRestrictions(runs, board, undefined, settings);
  const accounts = new MemoryAccountRepository();
  const rolesRepository = new MemoryRolesRepository();
  const roles = new RolesService(config(), rolesRepository, accounts);
  const hooks = new RunsHooks();
  const recorded: RecordedRun[] = [];
  hooks.onRecorded("test", async (run) => {
    recorded.push(run);
  });
  const service = new RunsService(config(), runs, board, roles, hooks, new RunContinues(), new RunLoadouts(), rating.rating);
  const view = new RunsViewService(runs, board, new RunExtras(), rating.rating, new RunPrestige());
  const player = async (name: string): Promise<AccountRef> => {
    const created = await accounts.upsert({ platform: "telegram", platformUserId: String(Math.floor(Math.random() * 1e9)), displayName: name, username: null, photoUrl: null }, Date.now());
    return { accountId: created.accountId, platform: created.platform, platformUserId: created.platformUserId };
  };
  return { runs, board, settings, rating, rolesRepository, hooks, recorded, service, view, player };
}

/** Снимок обеих досок всех сложностей — для сравнения «живая проекция против пересборки». */
async function snapshot(board: MemoryLeaderboardStore): Promise<Record<string, [string, number][]>> {
  const result: Record<string, [string, number][]> = {};
  for (const difficulty of DIFFICULTIES) {
    for (const side of ALL_BOARDS) {
      const entries = await board.top(difficulty, 1_000, side);
      result[`${side}:${difficulty}`] = entries.map((entry): [string, number] => [entry.accountId, entry.survivalSec]).sort((left, right) => (left[0] < right[0] ? -1 : 1));
    }
  }
  return result;
}

describe("рейтинговые сложности в правилах", () => {
  it("единая сложность — hard; обучающая и прежняя нормальная в рейтинг не идут", () => {
    expect([...RATED_DIFFICULTIES]).toEqual(["hard"]);
    expect(isRatedDifficulty("hard")).toBe(true);
    expect(isRatedDifficulty("easy")).toBe(false);
    expect(isRatedDifficulty("normal")).toBe(false);
  });

  it("список сложностей прежний: старые клиенты по-прежнему присылают easy и normal", () => {
    expect([...DIFFICULTIES]).toEqual(["easy", "normal", "hard"]);
  });
});

describe("ratingSinceOf: число ГГГГММДД в начало суток UTC", () => {
  it("20261026 — полночь 26 октября по UTC", () => {
    expect(ratingSinceOf(20261026)?.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(ratingSinceOf(20270101)?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it.each([0, -1, 1.5, 20261340, 20260229, 20261000, 20260100, 2026102, 202610260, Number.NaN, Number.POSITIVE_INFINITY])("не дата — отсечки нет: %j", (value) => {
    expect(ratingSinceOf(value)).toBeNull();
  });

  it("високосный день — дата", () => {
    expect(ratingSinceOf(20280229)?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });
});

describe("isRatedRun: рейтинговая сложность и не раньше отсечки", () => {
  const since = new Date(SINCE_MS);

  it("hard после отсечки — да; ровно в полночь отсечки — да; за секунду до — нет", () => {
    expect(isRatedRun("hard", new Date(SINCE_MS + HOUR), since)).toBe(true);
    expect(isRatedRun("hard", new Date(SINCE_MS), since)).toBe(true);
    expect(isRatedRun("hard", new Date(SINCE_MS - 1_000), since)).toBe(false);
  });

  it("easy и normal — нет, в любое время", () => {
    for (const difficulty of ["easy", "normal"] as const) {
      expect(isRatedRun(difficulty, new Date(SINCE_MS + HOUR), since)).toBe(false);
      expect(isRatedRun(difficulty, new Date(SINCE_MS + HOUR), null)).toBe(false);
    }
  });

  it("отсечки нет — hard рейтинговый всегда", () => {
    expect(isRatedRun("hard", new Date(0), null)).toBe(true);
  });
});

describe("ratedWhere: условие для запросов к таблице run", () => {
  it("без отсечки — только рейтинговые сложности", () => {
    expect(ratedWhere(null)).toEqual({ difficulty: { in: ["hard"] } });
  });

  it("с отсечкой — ещё и finished_at не раньше неё", () => {
    const since = new Date(SINCE_MS);
    expect(ratedWhere(since)).toEqual({ difficulty: { in: ["hard"] }, finishedAt: { gte: since } });
  });
});

describe("ключ настроек rating.since-date", () => {
  const setting = SETTINGS.ratingSinceDate;

  it("есть в каталоге, в своей группе, умолчание — без отсечки, окружения нет", () => {
    expect(SETTING_LIST).toContain(setting);
    expect(setting.key).toBe("rating.since-date");
    expect(setting.group).toBe("Рейтинг");
    expect(setting.kind).toBe("number");
    expect(setting.fallback).toBe(0);
    expect((setting as SettingDefinition<number>).fromEnv(config())).toBeNull();
  });

  it("схема принимает ноль и существующую дату, отвергает несуществующую, дробь, отрицательное и мусор", () => {
    expect(setting.schema.safeParse(0).success).toBe(true);
    expect(setting.schema.safeParse(20261026).success).toBe(true);
    expect(setting.schema.safeParse(20261340).success).toBe(false);
    expect(setting.schema.safeParse(20260229).success).toBe(false);
    expect(setting.schema.safeParse(-1).success).toBe(false);
    expect(setting.schema.safeParse(1.5).success).toBe(false);
    expect(setting.schema.safeParse(21000101).success).toBe(false);
    expect(setting.schema.safeParse("20261026").success).toBe(false);
  });

  it("дату в прошлом ставить можно: проверки при сохранении нет", () => {
    expect((setting as SettingDefinition<number>).saveCheck).toBeUndefined();
  });

  it("редактор панели покажет единицу «(ГГГГММДД)» и пределы", () => {
    expect(setting.range).toMatchObject({ min: 0, max: 20_991_231 });
    expect(setting.range?.unit[0]).toBe("(ГГГГММДД)");
  });
});

describe("приём забегов: рейтинг только у единой сложности", () => {
  let w: ReturnType<typeof world>;

  beforeEach(() => {
    w = world();
  });

  it("hard после отсечки — в рейтинге: место, лучшее, доска", async () => {
    const me = account();

    const result = await w.service.finish(me, runOf("hard"), AFTER_MS);

    expect(result).toEqual({ recorded: true, verdict: "ok", bestSurvivalSec: 120, isNewBest: true, rank: 1 });
    expect(await w.board.best("hard", me.accountId, "common")).toBe(120);
    expect(await w.board.best("hard", me.accountId, "full")).toBe(120);
    expect(w.recorded[0]).toMatchObject({ difficulty: "hard", ranked: true });
  });

  it.each(["easy", "normal"] as const)("%s принимается, но в рейтинг не идёт: recorded false, места нет, доски пусты", async (difficulty) => {
    const me = account();
    const run = runOf(difficulty);

    const result = await w.service.finish(me, run, AFTER_MS);

    expect(result).toEqual({ recorded: false, verdict: "ok", bestSurvivalSec: 0, isNewBest: false, rank: null });
    for (const side of ALL_BOARDS) expect(await w.board.best(difficulty, me.accountId, side)).toBeNull();
    // История цела: забег записан, вердикт честный, читов нет, просто не рейтинговый.
    expect(w.runs.rows.get(run.runId)?.record).toMatchObject({ difficulty, ranked: false, ratingRestricted: null, verdict: "ok", cheats: false });
    expect((await w.view.profile(me.accountId)).runs).toBe(1);
  });

  it("награда за нерейтинговые забеги прежняя: слушатели получают тот же забег, множители не менялись", async () => {
    const me = account();
    await w.service.finish(me, runOf("easy"), AFTER_MS);
    await w.service.finish(me, runOf("normal"), AFTER_MS);
    await w.service.finish(me, runOf("hard"), AFTER_MS);

    expect(w.recorded.map((run) => [run.difficulty, run.ranked, run.verdict])).toEqual([
      ["easy", false, "ok"],
      ["normal", false, "ok"],
      ["hard", true, "ok"],
    ]);
    const coins = w.recorded.map((run) => runReward(run));
    for (const reward of coins) expect(reward.skipped).toBeNull();
    expect(coins[0]?.coins).toBeGreaterThan(0);
    expect(coins[1]?.coins).toBeGreaterThan(coins[0]?.coins ?? 0);
    expect(coins[2]?.coins).toBeGreaterThan(coins[1]?.coins ?? 0);
    expect(DIFFICULTY_REWARD_MUL).toEqual({ easy: 1, normal: 1.3, hard: 1.7 });
    expect(DIFFICULTY_LEVEL_BONUS).toEqual({ easy: 0, normal: 1, hard: 2 });
  });

  it("нерейтинговый забег Redis не трогает вовсе: ни записи, ни чтения места", async () => {
    const untouched = new RunsService(
      config(),
      w.runs,
      untouchable<LeaderboardStore>("redis"),
      new RolesService(config(), new MemoryRolesRepository(), new MemoryAccountRepository()),
      new RunsHooks(),
      new RunContinues(),
      new RunLoadouts(),
      w.rating.rating,
    );

    await expect(untouched.finish(account(), runOf("easy"), AFTER_MS)).resolves.toMatchObject({ recorded: false, rank: null });
    await expect(untouched.finish(account(), runOf("normal"), AFTER_MS)).resolves.toMatchObject({ recorded: false, rank: null });
  });

  it("hard, законченный до отсечки, в рейтинг не идёт; ровно в отсечку — идёт", async () => {
    const me = account();
    const early = runOf("hard", { survivalSec: 600 });

    const before = await w.service.finish(me, early, SINCE_MS - 1_000);

    expect(before).toMatchObject({ recorded: false, verdict: "ok", isNewBest: false });
    expect(await w.board.best("hard", me.accountId, "common")).toBeNull();
    expect(w.runs.rows.get(early.runId)?.record).toMatchObject({ ranked: false, ratingRestricted: null });

    expect(await w.service.finish(me, runOf("hard", { survivalSec: 100 }), SINCE_MS)).toMatchObject({ recorded: true, rank: 1, bestSurvivalSec: 100 });
  });

  it("отсечки нет (0) — hard рейтинговый в любое время, остальные по-прежнему нет", async () => {
    const open = world(0);
    const me = account();

    expect(await open.service.finish(me, runOf("hard"), 1_000_000)).toMatchObject({ recorded: true, rank: 1 });
    expect(await open.service.finish(me, runOf("easy"), 1_000_000)).toMatchObject({ recorded: false, rank: null });
  });

  it("отсечку сдвинули из панели — действует на следующем же забеге, без перезапуска", async () => {
    const me = account();
    w.settings.set(SINCE_KEY, 20261101);

    expect(await w.service.finish(me, runOf("hard"), AFTER_MS)).toMatchObject({ recorded: false });
    expect(await w.service.finish(me, runOf("hard"), Date.UTC(2026, 10, 1, 1))).toMatchObject({ recorded: true });
  });

  it("повтор итога нерейтингового забега — тот же ответ, без записи", async () => {
    const me = account();
    for (const difficulty of ["easy", "normal"] as const) {
      const run = runOf(difficulty);
      const first = await w.service.finish(me, run, AFTER_MS);
      const again = await w.service.finish(me, run, AFTER_MS + 5_000);
      expect(again).toEqual(first);
    }
    expect(w.recorded).toHaveLength(2);
    expect(await w.board.count("easy", "common")).toBe(0);
    expect(await w.board.count("normal", "common")).toBe(0);
  });

  it("повтор итога hard, законченного до отсечки, — тот же ответ, в доску не попадает", async () => {
    const me = account();
    const run = runOf("hard", { survivalSec: 900 });
    const first = await w.service.finish(me, run, SINCE_MS - HOUR);

    const again = await w.service.finish(me, run, AFTER_MS);

    expect(again).toEqual(first);
    expect(await w.board.best("hard", me.accountId, "common")).toBeNull();
  });

  it("повтор итога, принятого до сдвига отсечки, не пишет старый забег в чистую доску", async () => {
    // Забег был рейтинговым, потом отсечку подвинули вперёд, а доску успели пересобрать; клиент повторяет итог из очереди.
    const open = world(0);
    const me = account();
    const run = runOf("hard", { survivalSec: 700 });
    await open.service.finish(me, run, Date.UTC(2026, 9, 20));
    for (const side of ALL_BOARDS) await open.board.replace("hard", side, []);
    open.settings.set(SINCE_KEY, 20261026);

    const again = await open.service.finish(me, run, AFTER_MS);

    expect(again).toMatchObject({ recorded: false });
    expect(await open.board.best("hard", me.accountId, "common")).toBeNull();
    expect(await open.board.best("hard", me.accountId, "full")).toBeNull();
  });

  it("повтор итога легаси-забега easy/normal с ranked = true в базе в доску не пишет", async () => {
    const me = account();
    const old = legacy(me.accountId, "normal", 800, SINCE_MS - 5 * HOUR);
    await w.runs.finish(old);

    const result = await w.service.finish(me, runOf("normal", { runId: old.runId, survivalSec: 800 }), AFTER_MS);

    expect(result).toEqual({ recorded: false, verdict: "ok", bestSurvivalSec: 0, isNewBest: false, rank: null });
    expect(await w.board.best("normal", me.accountId, "common")).toBeNull();
  });

  it("забег с читами и отклонённый на единой сложности по-прежнему мимо рейтинга", async () => {
    const result = await w.service.finish(account(), runOf("hard", { cheats: true, countInRating: true }), AFTER_MS);

    expect(result).toMatchObject({ recorded: false });
  });
});

describe("снятие с рейтинга и возврат (setRanked)", () => {
  let w: ReturnType<typeof world>;
  let moderator: AccountRef;

  beforeEach(async () => {
    w = world();
    moderator = await w.player("модератор");
    await w.rolesRepository.grant(moderator.accountId, "moderator", null);
  });

  it("нерейтинговый забег не вернуть: easy и normal похожи на «снятый модератором», но им не являются", async () => {
    const target = await w.player("Игрок");
    for (const difficulty of ["easy", "normal"] as const) {
      const run = runOf(difficulty);
      await w.service.finish(target, run, AFTER_MS);

      await expect(w.service.setRanked(moderator, run.runId, true, "вернуть")).rejects.toBeInstanceOf(RunRankingConflictError);
      await expect(w.service.setRanked(moderator, run.runId, false, "снять")).rejects.toMatchObject({ code: "run_ranking_conflict" });
    }
    expect(await w.board.count("easy", "common")).toBe(0);
  });

  it("hard раньше отсечки тоже не вернуть и не снять", async () => {
    const target = await w.player("Игрок");
    const run = runOf("hard", { survivalSec: 500 });
    await w.service.finish(target, run, SINCE_MS - HOUR);

    await expect(w.service.setRanked(moderator, run.runId, true, "вернуть")).rejects.toMatchObject({ code: "run_ranking_conflict" });
    await expect(w.service.setRanked(moderator, run.runId, false, "снять")).rejects.toMatchObject({ code: "run_ranking_conflict" });
    expect(await w.board.best("hard", target.accountId, "common")).toBeNull();
  });

  it("старая запись с ranked = true на нерейтинговой сложности не снимается: доска не пересчитывается", async () => {
    const target = await w.player("Игрок");
    const old = legacy(target.accountId, "normal", 800, AFTER_MS);
    await w.runs.finish(old);

    await expect(w.service.setRanked(moderator, old.runId, false, "накрутка")).rejects.toMatchObject({ code: "run_ranking_conflict" });
    expect(w.runs.rows.get(old.runId)?.ranked).toBe(true);
  });

  it("hard после отсечки по-прежнему снимается и возвращается", async () => {
    const target = await w.player("Игрок");
    const run = runOf("hard", { survivalSec: 500 });
    await w.service.finish(target, run, AFTER_MS);

    await w.service.setRanked(moderator, run.runId, false, "накрутка");
    expect(await w.board.best("hard", target.accountId, "common")).toBeNull();
    await w.service.setRanked(moderator, run.runId, true, "ошиблись");
    expect(await w.board.best("hard", target.accountId, "common")).toBe(500);
  });
});

describe("пересборка рейтинга из базы равна живой проекции", () => {
  /** Один и тот же набор забегов: рейтинговые до и после отсечки, easy, normal. */
  async function playAll(w: ReturnType<typeof world>) {
    const [first, second, third, closed] = [await w.player("Первый"), await w.player("Второй"), await w.player("Третий"), await w.player("Закрытый")];
    w.rating.restrictions.restrict(closed.accountId, "leaderboard", { notify: true });
    const plan: [AccountRef, Difficulty, number, number][] = [
      [first, "hard", 300, AFTER_MS],
      [first, "hard", 900, SINCE_MS - HOUR],
      [first, "easy", 800, AFTER_MS],
      [second, "hard", 200, AFTER_MS + HOUR],
      [second, "normal", 700, AFTER_MS],
      [third, "hard", 400, SINCE_MS - 2 * HOUR],
      [third, "easy", 600, AFTER_MS],
      [closed, "hard", 500, AFTER_MS],
    ];
    for (const [who, difficulty, survivalSec, at] of plan) await w.service.finish(who, runOf(difficulty, { survivalSec }), at);
    return { first, second, third, closed };
  }

  it("доски после пересборки совпадают с теми, что собрали живые забеги; второй запуск ничего не меняет", async () => {
    const w = world();
    const players = await playAll(w);
    const live = await snapshot(w.board);
    expect(live["common:hard"]).toEqual([
      [players.first.accountId, 300],
      [players.second.accountId, 200],
    ].sort((left, right) => (left[0] as string < (right[0] as string) ? -1 : 1)));

    for (const side of ALL_BOARDS) await w.board.replace("hard", side, []);
    const counts = await w.service.rebuildLeaderboard();
    const rebuilt = await snapshot(w.board);

    expect(rebuilt).toEqual(live);
    expect(counts.hard).toEqual({ full: 2, common: 2 });
    expect(counts.easy).toEqual({ full: 0, common: 0 });
    expect(counts.normal).toEqual({ full: 0, common: 0 });

    await w.service.rebuildLeaderboard();
    expect(await snapshot(w.board)).toEqual(rebuilt);
  });

  it("доски easy и normal после пересборки пусты, даже если в них лежали старые записи; забег до отсечки на hard тоже вычищен", async () => {
    const w = world();
    const { first, third } = await playAll(w);
    for (const stale of ["easy", "normal", "hard"] as const) {
      await w.board.submit(stale, first.accountId, 999, ALL_BOARDS);
      await w.board.submit(stale, third.accountId, 888, ALL_BOARDS);
    }

    await w.service.rebuildLeaderboard();

    for (const side of ALL_BOARDS) {
      expect(await w.board.count("easy", side)).toBe(0);
      expect(await w.board.count("normal", side)).toBe(0);
    }
    expect(await w.board.best("hard", first.accountId, "common")).toBe(300);
    expect(await w.board.best("hard", third.accountId, "common")).toBeNull();
  });

  it("легаси-записи в базе (ranked = true на easy, normal и hard до отсечки) в доски не возвращаются", async () => {
    const w = world();
    const me = account();
    await w.runs.finish(legacy(me.accountId, "easy", 900, AFTER_MS));
    await w.runs.finish(legacy(me.accountId, "normal", 800, AFTER_MS));
    await w.runs.finish(legacy(me.accountId, "hard", 700, SINCE_MS - HOUR));
    await w.runs.finish(legacy(me.accountId, "hard", 100, AFTER_MS));

    const counts = await w.service.rebuildLeaderboard();

    expect(counts).toEqual({ easy: { full: 0, common: 0 }, normal: { full: 0, common: 0 }, hard: { full: 1, common: 1 } });
    expect(await w.board.best("hard", me.accountId, "common")).toBe(100);
  });

  it("без отсечки пересборка берёт все забеги hard", async () => {
    const w = world(0);
    const me = account();
    await w.runs.finish(legacy(me.accountId, "hard", 700, SINCE_MS - HOUR));

    expect((await w.service.rebuildLeaderboard()).hard).toEqual({ full: 1, common: 1 });
  });
});

describe("чтение: доски нерейтинговых сложностей пусты", () => {
  it("leaderboardFor(easy) и (normal) — пустая доска той же формы без обращения к Redis, базе и ограничениям", async () => {
    const w = world();
    const view = new RunsViewService(
      untouchable<RunsRepository>("база"),
      untouchable<LeaderboardStore>("redis"),
      new RunExtras(),
      untouchable<typeof w.rating.rating>("ограничения"),
      new RunPrestige(),
    );

    for (const difficulty of ["easy", "normal"] as const) {
      expect(await view.leaderboardFor(randomUUID(), difficulty)).toEqual({ difficultyId: difficulty, entries: [], me: null, totalPlayers: 0 });
    }
  });

  it("даже со старыми записями в Redis: профиль не видит easy и normal, размер доски — ноль, лидерборд hard — только рейтинговые", async () => {
    const w = world();
    const me = await w.player("Я");
    await w.service.finish(me, runOf("hard", { survivalSec: 250 }), AFTER_MS);
    for (const stale of ["easy", "normal"] as const) await w.board.submit(stale, me.accountId, 999, ALL_BOARDS);

    const profile = await w.view.profile(me.accountId);

    expect(profile.best).toEqual({ easy: null, normal: null, hard: { survivalSec: 250, rank: 1 } });
    expect(await w.view.boardSize(me.accountId, "easy")).toBe(0);
    expect(await w.view.boardSize(me.accountId, "normal")).toBe(0);
    expect(await w.view.boardSize(me.accountId, "hard")).toBe(1);
    expect((await w.view.leaderboardFor(me.accountId, "easy")).entries).toEqual([]);
    expect((await w.view.leaderboardFor(me.accountId, "hard")).me).toEqual({ rank: 1, survivalSec: 250 });
  });

  it("игрок в тени на единой сложности видит себя, на нерейтинговых — пусто", async () => {
    const w = world();
    const shadow = await w.player("Тень");
    w.rating.restrictions.restrict(shadow.accountId, "leaderboard", { notify: false });
    await w.service.finish(shadow, runOf("hard", { survivalSec: 250 }), AFTER_MS);
    await w.service.finish(shadow, runOf("easy", { survivalSec: 900 }), AFTER_MS);

    const profile = await w.view.profile(shadow.accountId);

    expect(profile.best.hard).toMatchObject({ survivalSec: 250 });
    expect(profile.best.easy).toBeNull();
    expect((await w.view.leaderboardFor(shadow.accountId, "easy")).me).toBeNull();
  });

  it("moderationRuns: списки easy и normal пусты, форма ответа прежняя; hard — только после отсечки", async () => {
    const w = world();
    const me = await w.player("Я");
    await w.service.finish(me, runOf("hard", { survivalSec: 250 }), AFTER_MS);
    await w.service.finish(me, runOf("hard", { survivalSec: 900 }), SINCE_MS - HOUR);
    await w.service.finish(me, runOf("easy", { survivalSec: 800 }), AFTER_MS);
    await w.runs.finish(legacy(me.accountId, "normal", 700, AFTER_MS));

    const lists = await w.view.moderationRuns(me.accountId);

    expect(Object.keys(lists).sort()).toEqual(["easy", "hard", "normal"]);
    expect(lists.easy).toEqual([]);
    expect(lists.normal).toEqual([]);
    expect(lists.hard.map((run) => [run.survivalSec, run.ranked])).toEqual([[250, true]]);
  });
});

describe("RatingRestrictions: возврат в доски после снятия ограничения", () => {
  it("settled возвращает лучший забег только единой сложности и только после отсечки", async () => {
    const w = world();
    const me = account();
    await w.runs.finish(legacy(me.accountId, "easy", 900, AFTER_MS));
    await w.runs.finish(legacy(me.accountId, "normal", 800, AFTER_MS));
    await w.runs.finish(legacy(me.accountId, "hard", 700, SINCE_MS - HOUR));
    await w.runs.finish(legacy(me.accountId, "hard", 300, AFTER_MS));

    await w.rating.hooks.emitSettled({ accountId: me.accountId, kinds: ["leaderboard"], at: new Date(AFTER_MS) });

    expect(await w.board.best("easy", me.accountId, "common")).toBeNull();
    expect(await w.board.best("normal", me.accountId, "common")).toBeNull();
    expect(await w.board.best("hard", me.accountId, "common")).toBe(300);
  });

  it("since() берёт отсечку из настроек на каждый вызов: правка в панели действует сразу", () => {
    const w = world(null);
    expect(w.rating.rating.since()).toBeNull();
    w.settings.set(SINCE_KEY, 20261026);
    expect(w.rating.rating.since()?.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    w.settings.set(SINCE_KEY, 0);
    expect(w.rating.rating.since()).toBeNull();
  });

  it("набор досок обычного игрока не менялся: обе", async () => {
    const w = world();
    const boards: readonly Board[] = await w.rating.rating.boardsFor(randomUUID());
    expect(boards).toEqual(ALL_BOARDS);
  });
});
