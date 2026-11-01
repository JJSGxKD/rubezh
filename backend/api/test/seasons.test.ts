import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import type { RunFinish } from "../src/modules/runs/dto/runs.dto.js";
import { RunContinues } from "../src/modules/runs/run-continues.js";
import { RunLoadouts } from "../src/modules/runs/run-loadouts.js";
import { DIFFICULTIES } from "../src/modules/runs/run-rules.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { SETTINGS, SETTING_LIST } from "../src/modules/settings/setting-catalog.js";
import { boardQuerySchema, seasonKeyParamSchema } from "../src/modules/seasons/dto/seasons.dto.js";
import {
  MIN_BOARD,
  PLACE_LADDER,
  SEASON_REWARD_KEYS,
  assertInGameReward,
  standings,
  THRESHOLD_REWARD,
  THRESHOLD_SEC,
  dueSeasons,
  MAX_CATCH_UP_WEEKS,
  parseStartDate,
  placeReward,
  rewardFor,
  seasonByKey,
  seasonOf,
  thresholdReached,
  type StandingEntry,
} from "../src/modules/seasons/season-rules.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryLeaderboardStore, MemoryRunsRepository, ratingRestrictions } from "./helpers/memory-runs.js";

/**
 * Недельный сезон рейтинга: правила без базы (tasks/T-0110). Границы недели —
 * календарные, UTC; награды — стартовые числа, которые калибрует
 * геймдизайнер, поэтому тест называет их явно: правка числа в
 * `season-rules.ts` ломает его и попадает в дифф.
 */

const iso = (date: Date): string => date.toISOString();

describe("seasonOf: календарная неделя UTC", () => {
  it("понедельник 00:00 — начало сезона, следующий понедельник 00:00 — конец", () => {
    const season = seasonOf(new Date("2026-11-02T00:00:00Z"));
    expect(season.key).toBe("2026-11-02");
    expect(iso(season.startsAt)).toBe("2026-11-02T00:00:00.000Z");
    expect(iso(season.endsAt)).toBe("2026-11-09T00:00:00.000Z");
  });

  it("воскресенье 23:59:59.999 — ещё тот же сезон, понедельник 00:00 — уже следующий", () => {
    expect(seasonOf(new Date("2026-11-08T23:59:59.999Z")).key).toBe("2026-11-02");
    expect(seasonOf(new Date("2026-11-09T00:00:00Z")).key).toBe("2026-11-09");
  });

  it("воскресенье относится к неделе, начавшейся понедельником до него", () => {
    expect(seasonOf(new Date("2026-11-08T12:00:00Z")).key).toBe("2026-11-02");
  });

  it("стык годов: ключ — дата понедельника, а не номер недели ISO", () => {
    expect(seasonOf(new Date("2026-12-31T10:00:00Z")).key).toBe("2026-12-28");
    expect(seasonOf(new Date("2027-01-03T23:59:59Z")).key).toBe("2026-12-28");
    expect(seasonOf(new Date("2027-01-04T00:00:00Z")).key).toBe("2027-01-04");
    expect(iso(seasonOf(new Date("2026-12-31T10:00:00Z")).endsAt)).toBe("2027-01-04T00:00:00.000Z");
  });

  it("время суток в локальном поясе часов сервера на неделю не влияет: считается по UTC", () => {
    // Полночь по Москве с воскресенья на понедельник — ещё воскресенье по UTC.
    expect(seasonOf(new Date("2026-11-08T21:00:00Z")).key).toBe("2026-11-02");
  });
});

describe("seasonByKey", () => {
  it("ключ-понедельник разбирается обратно в тот же сезон", () => {
    expect(seasonByKey("2026-11-02")).toEqual(seasonOf(new Date("2026-11-02T00:00:00Z")));
  });

  it.each(["2026-11-03", "2026-02-30", "26-11-02", "2026-11-2", "", "2026-W45", "2026-11-02 "])("не понедельник и не дата отклоняется: %j", (key) => {
    expect(seasonByKey(key)).toBeNull();
  });
});

describe("dueSeasons: какие сезоны пора закрыть", () => {
  const start = new Date("2026-11-02T00:00:00Z");
  const keys = (result: { due: { key: string }[] }) => result.due.map((season) => season.key);

  it("сезон ещё идёт — закрывать нечего; ровно в конце — пора", () => {
    expect(dueSeasons(start, new Date("2026-11-08T23:59:59.999Z"))).toEqual({ due: [], skipped: 0 });
    expect(keys(dueSeasons(start, new Date("2026-11-09T00:00:00Z")))).toEqual(["2026-11-02"]);
  });

  it("сервер лежал две недели — просрочены оба сезона, по порядку", () => {
    const result = dueSeasons(start, new Date("2026-11-16T03:00:00Z"));
    expect(keys(result)).toEqual(["2026-11-02", "2026-11-09"]);
    expect(result.skipped).toBe(0);
  });

  it("до первого сезона закрывать нечего", () => {
    expect(dueSeasons(start, new Date("2026-10-30T00:00:00Z"))).toEqual({ due: [], skipped: 0 });
  });

  it("старт три недели назад — только два последних закончившихся сезона, старший пропущен", () => {
    const result = dueSeasons(new Date("2026-10-19T00:00:00Z"), new Date("2026-11-09T12:00:00Z"));
    expect(keys(result)).toEqual(["2026-10-26", "2026-11-02"]);
    expect(result.skipped).toBe(1);
  });

  it("старт на текущей неделе — закрывать нечего, ничего не пропущено", () => {
    expect(dueSeasons(new Date("2026-11-09T00:00:00Z"), new Date("2026-11-11T10:00:00Z"))).toEqual({ due: [], skipped: 0 });
  });

  it("сезон кончился ровно две недели назад — ещё в пределах догона", () => {
    const result = dueSeasons(new Date("2026-10-26T00:00:00Z"), new Date("2026-11-16T00:00:00Z"));
    expect(keys(result)).toEqual(["2026-10-26", "2026-11-02", "2026-11-09"]);
    expect(result.skipped).toBe(0);
  });

  it("потолок догона — две недели", () => {
    expect(MAX_CATCH_UP_WEEKS).toBe(2);
  });
});

describe("parseStartDate: настройка seasons.start-date", () => {
  it("ноль и пусто — сезонов нет", () => {
    expect(parseStartDate(0)).toBeNull();
  });

  it("понедельник ГГГГММДД — начало первого сезона", () => {
    expect(iso(parseStartDate(20261102) ?? new Date(0))).toBe("2026-11-02T00:00:00.000Z");
  });

  it.each([20261103, 20260230, 2026110, 202611020, -1, 1.5])("не понедельник и не дата — нет сезонов: %j", (value) => {
    expect(parseStartDate(value)).toBeNull();
  });
});

describe("ключ настроек seasons.start-date", () => {
  const setting = SETTINGS.seasonsStartDate;

  it("есть в каталоге, ключ в формате, умолчание — выключено", () => {
    expect(SETTING_LIST).toContain(setting);
    expect(setting.key).toBe("seasons.start-date");
    expect(setting.fallback).toBe(0);
  });

  it("схема принимает ноль и понедельник, отклоняет другие дни и мусор", () => {
    expect(setting.schema.safeParse(0).success).toBe(true);
    expect(setting.schema.safeParse(20261102).success).toBe(true);
    expect(setting.schema.safeParse(20261103).success).toBe(false);
    expect(setting.schema.safeParse(20260230).success).toBe(false);
    expect(setting.schema.safeParse("2026-11-02").success).toBe(false);
  });
});

describe("thresholdReached", () => {
  it("ровно порог — засчитано, на 0.1 секунды меньше — нет", () => {
    for (const difficulty of DIFFICULTIES) {
      expect(thresholdReached(difficulty, THRESHOLD_SEC[difficulty]), difficulty).toBe(true);
      expect(thresholdReached(difficulty, THRESHOLD_SEC[difficulty] - 0.1), difficulty).toBe(false);
    }
  });

  it("пороги — стартовые 180 / 150 / 90 секунд", () => {
    expect(THRESHOLD_SEC).toEqual({ easy: 180, normal: 150, hard: 90 });
  });
});

describe("placeReward", () => {
  it("место 1 на лёгкой при 20 игроках — 1000 монет и 100 престижа; на сложной — с множителем 1.7", () => {
    expect(placeReward(1, 20, "easy")).toEqual({ coins: 1000, prestige: 100 });
    expect(placeReward(1, 20, "hard")).toEqual({ coins: 1700, prestige: 170 });
    expect(placeReward(1, 20, "normal")).toEqual({ coins: 1300, prestige: 130 });
  });

  it("места 2–3, 4–10 и 11–50 берут свои ступени", () => {
    expect(placeReward(2, 20, "easy")).toEqual({ coins: 600, prestige: 50 });
    expect(placeReward(3, 20, "easy")).toEqual({ coins: 600, prestige: 50 });
    expect(placeReward(4, 20, "easy")).toEqual({ coins: 400, prestige: 25 });
    expect(placeReward(10, 20, "easy")).toEqual({ coins: 400, prestige: 25 });
    expect(placeReward(11, 20, "easy")).toEqual({ coins: 250, prestige: 10 });
    expect(placeReward(50, 60, "easy")).toEqual({ coins: 250, prestige: 10 });
  });

  it("результат округляется Math.round: 25 × 1.7 = 42.5 → 43", () => {
    expect(placeReward(10, 20, "hard")).toEqual({ coins: 680, prestige: 43 });
  });

  it("место 51 — без награды за место", () => {
    expect(placeReward(51, 100, "easy")).toBeNull();
  });

  it("таблица меньше MIN_BOARD игроков — без награды за место, ровно MIN_BOARD — с наградой", () => {
    expect(MIN_BOARD).toBe(10);
    expect(placeReward(1, 9, "easy")).toBeNull();
    expect(placeReward(1, 10, "easy")).toEqual({ coins: 1000, prestige: 100 });
  });

  it("лестница в контракте: ступени подряд, без дыр и перекрытий, с 1 места", () => {
    expect(PLACE_LADDER[0]?.fromPlace).toBe(1);
    for (let index = 1; index < PLACE_LADDER.length; index++) {
      expect(PLACE_LADDER[index]?.fromPlace).toBe((PLACE_LADDER[index - 1]?.toPlace ?? 0) + 1);
    }
  });

  it("нулевое и отрицательное место — не награда", () => {
    expect(placeReward(0, 20, "easy")).toBeNull();
    expect(placeReward(-1, 20, "easy")).toBeNull();
  });
});

describe("rewardFor: одна награда на аккаунт и сезон", () => {
  const row = (difficulty: (typeof DIFFICULTIES)[number], bestSec: number, place: number, boardSize: number) => ({ difficulty, bestSec, place, boardSize });

  it("порог на двух сложностях — одна награда за порог, без сложности и места", () => {
    const prize = rewardFor([row("easy", 200, 30, 5), row("normal", 160, 9, 9)]);
    expect(prize).toEqual({ kind: "threshold", difficulty: null, place: null, coins: THRESHOLD_REWARD.coins, prestige: THRESHOLD_REWARD.prestige });
    expect(THRESHOLD_REWARD).toEqual({ coins: 150, prestige: 5 });
  });

  it("место на обычной и порог на лёгкой — награда за место с множителем 1.3, а не сумма", () => {
    const prize = rewardFor([row("easy", 200, 40, 5), row("normal", 400, 1, 20)]);
    expect(prize).toEqual({ kind: "place", difficulty: "normal", place: 1, coins: 1300, prestige: 130 });
  });

  it("место на двух сложностях — большая награда, а не обе", () => {
    expect(rewardFor([row("easy", 400, 1, 20), row("hard", 400, 5, 20)])).toMatchObject({ kind: "place", difficulty: "easy", coins: 1000 });
    expect(rewardFor([row("easy", 400, 3, 20), row("hard", 400, 3, 20)])).toMatchObject({ kind: "place", difficulty: "hard", coins: 1020 });
  });

  it("за место награда заменяет награду за порог, а не прибавляется", () => {
    const prize = rewardFor([row("easy", 400, 4, 20)]);
    expect(prize).toMatchObject({ kind: "place", coins: 400, prestige: 25 });
  });

  it("не дотянул до порога и вне мест — награды нет", () => {
    expect(rewardFor([row("easy", 100, 70, 80), row("hard", 60, 3, 4)])).toBeNull();
    expect(rewardFor([])).toBeNull();
  });

  it("место в таблице меньше MIN_BOARD награды не даёт, порог — даёт", () => {
    expect(rewardFor([row("easy", 100, 1, 3)])).toBeNull();
    expect(rewardFor([row("easy", 190, 1, 3)])).toMatchObject({ kind: "threshold" });
  });
});

describe("параметры запросов", () => {
  it("сложность обязательна, охват по умолчанию — все игроки", () => {
    expect(boardQuerySchema.parse({ difficulty: "hard" })).toEqual({ difficulty: "hard", scope: "all" });
    expect(boardQuerySchema.parse({ difficulty: "easy", scope: "friends" })).toEqual({ difficulty: "easy", scope: "friends" });
    expect(boardQuerySchema.safeParse({}).success).toBe(false);
    expect(boardQuerySchema.safeParse({ difficulty: "nightmare" }).success).toBe(false);
    expect(boardQuerySchema.safeParse({ difficulty: "easy", scope: "world" }).success).toBe(false);
  });

  it("ключ сезона в пути — только дата-понедельник", () => {
    expect(seasonKeyParamSchema.parse("2026-11-02")).toBe("2026-11-02");
    expect(seasonKeyParamSchema.safeParse("2026-11-03").success).toBe(false);
    expect(seasonKeyParamSchema.safeParse("../etc").success).toBe(false);
  });
});

describe("RunsHooks: ранг забега изменён модератором", () => {
  it("слушатели получают игрока и сложность; упавший не мешает остальным", async () => {
    const hooks = new RunsHooks();
    const seen: string[] = [];
    hooks.onRankingChanged("падает", async () => {
      throw new Error("сломался");
    });
    hooks.onRankingChanged("считает", async (change) => {
      seen.push(`${change.accountId}:${change.difficulty}`);
    });
    const log = vi.spyOn(Reflect.get(hooks, "logger") as { error: (line: string) => void }, "error").mockImplementation(() => undefined);

    await hooks.emitRankingChanged({ accountId: "a", difficulty: "hard" });

    expect(seen).toEqual(["a:hard"]);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("RunsService.setRanked: слушатели узнают о смене ранга", () => {
  it("снятие и возврат забега модератором доходят до слушателей с игроком и сложностью", async () => {
    const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);
    const accounts = new MemoryAccountRepository();
    const rolesRepository = new MemoryRolesRepository();
    const runs = new MemoryRunsRepository();
    const board = new MemoryLeaderboardStore();
    const hooks = new RunsHooks();
    const roles = new RolesService(config, rolesRepository, accounts);
    const service = new RunsService(config, runs, board, roles, hooks, new RunContinues(), new RunLoadouts(), ratingRestrictions(runs, board).rating);
    const player = async (name: string) => {
      const created = await accounts.upsert({ platform: "telegram", platformUserId: String(Math.floor(Math.random() * 1e9)), displayName: name, username: null, photoUrl: null }, Date.now());
      return { accountId: created.accountId, platform: created.platform, platformUserId: created.platformUserId };
    };
    const moderator = await player("модератор");
    await rolesRepository.grant(moderator.accountId, "moderator", null);
    const target = await player("игрок");
    const run: RunFinish = {
      runId: randomUUID(),
      difficultyId: "hard",
      outcome: "died",
      survivalSec: 250,
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
    await service.finish(target, run);
    const seen: string[] = [];
    hooks.onRankingChanged("test", async (change) => {
      seen.push(`${change.accountId === target.accountId ? "игрок" : "чужой"}:${change.difficulty}`);
    });

    await service.setRanked(moderator, run.runId, false, "накрутка");
    await service.setRanked(moderator, run.runId, true, "ошиблись");
    await expect(service.setRanked(moderator, run.runId, true, "ещё раз")).rejects.toMatchObject({ code: "run_ranking_conflict" });

    expect(seen).toEqual(["игрок:hard", "игрок:hard"]);
  });
});

describe("standings: две таблицы сезона (T-0114, Р104)", () => {
  const at = (hours: number): Date => new Date(Date.UTC(2026, 10, 2, hours));
  const entry = (accountId: string, bestSec: number, firstAtHours = 1): StandingEntry => ({ accountId, bestSec, firstAt: at(firstAtHours) });
  const placesOf = (table: readonly { accountId: string; place: number; boardSize: number }[]) => table.map((row) => [row.accountId, row.place, row.boardSize]);

  it("трое обычных и двое с ограничением, времена вперемешку: общая из троих с местами 1–3, полная из пяти", () => {
    const table = standings([entry("a", 300), entry("s1", 280), entry("b", 250), entry("s2", 200), entry("c", 100)], new Set(["s1", "s2"]));
    expect(placesOf(table.common)).toEqual([["a", 1, 3], ["b", 2, 3], ["c", 3, 3]]);
    expect(placesOf(table.full)).toEqual([["a", 1, 5], ["s1", 2, 5], ["b", 3, 5], ["s2", 4, 5], ["c", 5, 5]]);
  });

  it("обычный игрок, которого аккаунт с ограничением обогнал бы, получает место «как будто его нет»", () => {
    const table = standings([entry("s", 500), entry("a", 400)], new Set(["s"]));
    expect(placesOf(table.common)).toEqual([["a", 1, 1]]);
    expect(placesOf(table.full)).toEqual([["s", 1, 2], ["a", 2, 2]]);
  });

  it("ничья по времени решена тем, кто показал его раньше; одно время и одно время показа — одно место", () => {
    const table = standings([entry("late", 300, 5), entry("early", 300, 1), entry("x", 300, 5), entry("low", 100)], new Set());
    expect(table.common.map((row) => [row.accountId, row.place])).toEqual([["early", 1], ["late", 2], ["x", 2], ["low", 4]]);
  });

  it("пустое множество ограничений: общая равна полной", () => {
    const table = standings([entry("a", 300), entry("b", 200)], new Set());
    expect(table.common).toEqual(table.full);
  });

  it("все с ограничением: общая пуста, полная — все; нет никого — обе пусты", () => {
    const only = standings([entry("s1", 300), entry("s2", 200)], new Set(["s1", "s2"]));
    expect(only.common).toEqual([]);
    expect(only.full).toHaveLength(2);
    expect(standings([], new Set())).toEqual({ common: [], full: [] });
  });

  it("вход не меняется, а порядок записей на входе на места не влияет", () => {
    const entries = [entry("a", 100), entry("b", 300), entry("c", 200)];
    const copy = [...entries];
    const shuffled = [entries[2] as StandingEntry, entries[0] as StandingEntry, entries[1] as StandingEntry];
    expect(standings(entries, new Set())).toEqual(standings(shuffled, new Set()));
    expect(entries).toEqual(copy);
  });

  it("награда по таблице аккаунта: девять обычных и трое с ограничением — у обычных таблица из девяти без награды за место, у троих полная из двенадцати с ней", () => {
    const common = Array.from({ length: 9 }, (_, index) => entry(`n${String(index)}`, 400 - index * 10));
    const separate = ["s0", "s1", "s2"].map((id, index) => entry(id, 450 - index * 10));
    const table = standings([...common, ...separate], new Set(["s0", "s1", "s2"]));

    const prizeOf = (row: { place: number; boardSize: number }) => placeReward(row.place, row.boardSize, "easy");
    expect(table.common.every((row) => row.boardSize === 9 && prizeOf(row) === null)).toBe(true);
    expect(table.full.filter((row) => row.accountId.startsWith("s")).map(prizeOf)).toEqual([{ coins: 1000, prestige: 100 }, { coins: 600, prestige: 50 }, { coins: 600, prestige: 50 }]);
  });
});

describe("награды сезона — только внутриигровые (T-0114)", () => {
  it("ключи награды — ровно монеты и престиж", () => {
    expect([...SEASON_REWARD_KEYS]).toEqual(["coins", "prestige"]);
    for (const prize of [placeReward(1, 20, "easy"), rewardFor([{ difficulty: "easy", bestSec: 200, place: 40, boardSize: 5 }])]) {
      expect(prize).not.toBeNull();
      expect(Object.keys(prize ?? {}).filter((key) => key !== "kind" && key !== "difficulty" && key !== "place").sort()).toEqual(["coins", "prestige"]);
    }
  });

  it("assertInGameReward пропускает монеты и престиж; звёзды, TON, подарки и выплаты — нет", () => {
    expect(() => assertInGameReward({ coins: 600, prestige: 50 })).not.toThrow();
    expect(() => assertInGameReward({ coins: 0, prestige: 0 })).not.toThrow();
    for (const extra of ["stars", "ton", "gift", "payout", "referral", "partner", "gems"]) {
      expect(() => assertInGameReward({ coins: 1, prestige: 1, [extra]: 5 }), extra).toThrow(/внутриигров/);
    }
  });

  it("assertInGameReward не пускает дробные, отрицательные и не числа", () => {
    for (const bad of [{ coins: 1.5, prestige: 1 }, { coins: -1, prestige: 1 }, { coins: "100", prestige: 1 }, { coins: 1, prestige: Number.NaN }, { coins: 1 }]) {
      expect(() => assertInGameReward(bad as never), JSON.stringify(bad)).toThrow();
    }
  });

  it("ни одно значение лестницы и порога не выходит за монеты и престиж", () => {
    for (const step of PLACE_LADDER) expect(Object.keys(step).sort()).toEqual(["coins", "fromPlace", "prestige", "toPlace"]);
    expect(Object.keys(THRESHOLD_REWARD).sort()).toEqual(["coins", "prestige"]);
  });
});
