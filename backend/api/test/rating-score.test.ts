import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { EVENT_DICTIONARY } from "../src/modules/events/event-dictionary.js";
import type { EventRow } from "../src/modules/events/events.repository.js";
import type { EventsSink } from "../src/modules/events/events.sink.js";
import { bandOf, bundledExpectedTable, expectedRowOf, expectedTableSchema, type ExpectedTable } from "../src/modules/rating/expected-table.js";
import { RunScorer, type RunScoreInput } from "../src/modules/rating/run-scorer.service.js";
import { axisIndexes, expectedPointsOf, isOutOfRange, minuteOf, normalizeWeights, pointsOf, styleOf, type AxisValues, type ScoreParams } from "../src/modules/rating/score-rules.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryLeaderboardStore, MemoryRunsRepository, ratingRestrictions } from "./helpers/memory-runs.js";
import { panelSettings } from "./helpers/settings.js";
import type { AccountRef } from "../src/modules/roles/roles.service.js";
import { RolesService } from "../src/modules/roles/roles.service.js";
import { runFinishSchema, type RunFinish } from "../src/modules/runs/dto/runs.dto.js";
import { RunContinues } from "../src/modules/runs/run-continues.js";
import { RunLoadouts } from "../src/modules/runs/run-loadouts.js";
import { judgeRun, type VerdictInput } from "../src/modules/runs/run-verdict.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { SETTINGS, SETTING_LIST } from "../src/modules/settings/setting-catalog.js";

/**
 * Очки эффективности (tasks/T-0293, Р66, Р152): пять осей против ожидаемого
 * для силы игрока и минуты, очки, стиль, честность и ответ записи забега.
 * Таблица ожидаемого — настоящий файл `expected-runs.json`: тест ломается,
 * если файл разойдётся со схемой.
 */

const PARAMS: ScoreParams = { weights: { t: 0.4, k: 0.2, h: 0.2, c: 0.1, b: 0.1 }, enduranceExponent: 1.3, cap: 3 };

function table(): ExpectedTable {
  const bundled = bundledExpectedTable();
  if (bundled === null) throw new Error("таблица ожидаемого не разобралась");
  return bundled;
}

/** Забег ровно по ожидаемому: минута `minute` полосы `band`, все пять индексов — 1. */
function onTarget(minute: number, band = "average"): RunScoreInput {
  const row = expectedRowOf(table(), band, minute);
  const minutes = minute; // survivalSec = minute × 60 — минута целая
  const huntLog = row.huntPerMin > 0 ? [{ rank: "elite" as const, value: row.huntPerMin * minutes, aliveSec: row.huntKillSec.elite }] : [];
  return {
    survivalSec: minute * 60,
    enemiesKilled: row.killsPerMin * minutes,
    damageTaken: row.damageTakenPerMin * minutes,
    huntLog,
    buildScore: row.buildScore,
    power: 2.2,
    contentHash: table().contentHash,
  };
}

function indexesOf(input: RunScoreInput, params = PARAMS): AxisValues {
  const row = expectedRowOf(table(), bandOf(table(), input.power).id, minuteOf(input.survivalSec));
  return axisIndexes(input, row, params);
}

describe("таблица ожидаемого", () => {
  it("файл проходит свою схему: пять полос, двадцать минут в каждой, края полос открыты", () => {
    const loaded = table();

    expect(loaded.bands).toHaveLength(5);
    expect(loaded.rows).toHaveLength(100);
    expect(loaded.bands[0]?.fromPower).toBe(0);
    expect(loaded.bands[4]?.toPower).toBeNull();
    for (let index = 1; index < loaded.bands.length; index += 1) {
      expect(loaded.bands[index]?.fromPower).toBeGreaterThan(loaded.bands[index - 1]?.fromPower ?? 0);
    }
  });

  it("полоса — по силе забега; нет силы — средняя, граница уходит в старшую полосу, сила за краем — в крайние", () => {
    const loaded = table();

    expect(bandOf(loaded, null).id).toBe("average");
    expect(bandOf(loaded, 0).id).toBe("novice");
    expect(bandOf(loaded, 1.11).id).toBe("novice_average");
    expect(bandOf(loaded, 2).id).toBe("average");
    expect(bandOf(loaded, 3.75).id).toBe("full");
    expect(bandOf(loaded, 99).id).toBe("full");
    expect(bandOf(loaded, -1).id).toBe("novice");
  });

  it("минута вне 1…20 берётся с края: дальше двадцатой — двадцатая", () => {
    const loaded = table();

    expect(expectedRowOf(loaded, "average", 35)).toEqual(expectedRowOf(loaded, "average", 20));
    expect(expectedRowOf(loaded, "average", 0)).toEqual(expectedRowOf(loaded, "average", 1));
  });

  it("битая таблица схемой не принимается", () => {
    expect(expectedTableSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(expectedTableSchema.safeParse({ ...table(), rows: [] }).success).toBe(false);
  });

  it("минута забега — потолок от минут, от первой до двадцатой", () => {
    expect(minuteOf(0)).toBe(1);
    expect(minuteOf(59.9)).toBe(1);
    expect(minuteOf(60.1)).toBe(2);
    expect(minuteOf(600)).toBe(10);
    expect(minuteOf(5_000)).toBe(20);
  });
});

describe("оси и очки", () => {
  it("забег ровно по ожидаемому на десятой минуте — все индексы около единицы, очки около тысячи", () => {
    const input = onTarget(10);
    const indexes = indexesOf(input);

    for (const axis of ["t", "k", "h", "c", "b"] as const) expect(indexes[axis], axis).toBeCloseTo(1, 2);
    expect(pointsOf(indexes, PARAMS)).toBeGreaterThanOrEqual(998);
    expect(pointsOf(indexes, PARAMS)).toBeLessThanOrEqual(1_002);
  });

  it("двадцать минут: Стойкость — два в степени 1,3", () => {
    expect(indexesOf(onTarget(20)).t).toBeCloseTo(2 ** 1.3, 6);
  });

  it("Натиск: индекс пять в очки идёт тройкой, а сам индекс остаётся пятью", () => {
    const input = onTarget(10);
    const boosted = { ...input, enemiesKilled: input.enemiesKilled * 5 };
    const indexes = indexesOf(boosted);

    expect(indexes.k).toBeCloseTo(5, 6);
    // 1000 × (0,40 × 1 + 0,20 × 3 + 0,20 + 0,10 + 0,10)
    expect(pointsOf(indexes, PARAMS)).toBe(1_400);
  });

  it("Охота при нуле ожидаемого (ранние минуты без элит) — единица, как ни охотился", () => {
    const early = onTarget(2);
    const hunted = { ...early, huntLog: [{ rank: "elite" as const, value: 500, aliveSec: 3 }] };

    expect(expectedRowOf(table(), "average", 2).huntPerMin).toBe(0);
    expect(indexesOf(hunted).h).toBe(1);
  });

  it("забег без журнала охоты и без оценки сборки (старый клиент) — индексы этих осей единица", () => {
    const legacy = { ...onTarget(10), huntLog: null, buildScore: null };
    const indexes = indexesOf(legacy);

    expect(indexes.h).toBe(1);
    expect(indexes.b).toBe(1);
  });

  it("быстрее убитая элита стоит дороже, но не больше чем вдвое, а медленная — не меньше чем вполовину", () => {
    const input = onTarget(10);
    const value = input.huntLog?.[0]?.value ?? 0;
    const aliveSec = input.huntLog?.[0]?.aliveSec ?? 1;

    const fast = indexesOf({ ...input, huntLog: [{ rank: "elite", value, aliveSec: aliveSec / 10 }] });
    const slow = indexesOf({ ...input, huntLog: [{ rank: "elite", value, aliveSec: aliveSec * 10 }] });

    expect(fast.h).toBeCloseTo(2, 6);
    expect(slow.h).toBeCloseTo(0.5, 6);
  });

  it("Охота: босс, которого таблица не знает (ожидаемое время нуль), получает нижний край коридора скорости", () => {
    const input = onTarget(10);
    const value = (input.huntLog?.[0]?.value ?? 0) * 4;
    const withBoss = { ...input, huntLog: [{ rank: "boss" as const, value, aliveSec: 40 }] };

    expect(expectedRowOf(table(), "average", 10).huntKillSec.boss).toBe(0);
    expect(indexesOf(withBoss).h).toBeCloseTo(2, 6); // 4 × 0,5
  });

  it("Чистота: нулевой урон — верх коридора, два; урон втрое больше ожидаемого — нижний край 0,3 не пробивается", () => {
    const input = onTarget(10);

    expect(indexesOf({ ...input, damageTaken: 0 }).c).toBe(2);
    expect(indexesOf({ ...input, damageTaken: (input.damageTaken ?? 0) * 100 }).c).toBe(0.3);
  });

  it("забег без счётчика полученного урона — Чистота единица", () => {
    expect(indexesOf({ ...onTarget(10), damageTaken: null }).c).toBe(1);
  });

  it("Сборка: оценка против ожидаемого к минуте, а нулевое ожидаемое не делит на ноль", () => {
    const input = onTarget(10);

    expect(indexesOf({ ...input, buildScore: 12 }).b).toBeCloseTo(2, 6);
    expect(Number.isFinite(indexesOf({ ...onTarget(1), buildScore: 4 }).b)).toBe(true);
  });

  it("слишком короткий забег не взрывает темп: минут не меньше полуминуты", () => {
    const blink = { ...onTarget(1), survivalSec: 2, enemiesKilled: 10, damageTaken: 0, huntLog: [] };
    const indexes = indexesOf(blink);

    for (const value of Object.values(indexes)) expect(Number.isFinite(value)).toBe(true);
  });

  it("очки не растут выше потолка индекса, а потолок берётся из параметров", () => {
    const indexes: AxisValues = { t: 9, k: 9, h: 9, c: 9, b: 9 };

    expect(pointsOf(indexes, PARAMS)).toBe(3_000);
    expect(pointsOf(indexes, { ...PARAMS, cap: 2 })).toBe(2_000);
  });
});

describe("стиль забега", () => {
  it("сильнейшая ось по потолочному индексу", () => {
    expect(styleOf({ t: 1, k: 1, h: 2.4, c: 1, b: 1 }, PARAMS)).toBe("h");
    expect(styleOf({ t: 0.5, k: 0.6, h: 0.4, c: 1.9, b: 0.9 }, PARAMS)).toBe("c");
  });

  it("при равенстве — порядок Стойкость, Натиск, Охота, Чистота, Сборка", () => {
    expect(styleOf({ t: 1, k: 1, h: 1, c: 1, b: 1 }, PARAMS)).toBe("t");
    expect(styleOf({ t: 0.5, k: 2, h: 2, c: 0.5, b: 2 }, PARAMS)).toBe("k");
    expect(styleOf({ t: 0.5, k: 0.5, h: 0.5, c: 0.5, b: 1 }, PARAMS)).toBe("b");
  });

  it("выше потолка оси равны: выброс не выбирает стиль, побеждает порядок", () => {
    expect(styleOf({ t: 3, k: 9, h: 3, c: 1, b: 1 }, PARAMS)).toBe("t");
  });
});

describe("веса", () => {
  it("сумма не единица — веса нормируются к единице и это видно", () => {
    const normalized = normalizeWeights({ t: 0.48, k: 0.24, h: 0.24, c: 0.12, b: 0.12 });

    expect(normalized.normalized).toBe(true);
    expect(normalized.weights.t).toBeCloseTo(0.4, 9);
    expect(Object.values(normalized.weights).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 9);
  });

  it("сумма единица — веса как есть", () => {
    const normalized = normalizeWeights({ t: 0.4, k: 0.2, h: 0.2, c: 0.1, b: 0.1 });

    expect(normalized.normalized).toBe(false);
    expect(normalized.weights).toEqual({ t: 0.4, k: 0.2, h: 0.2, c: 0.1, b: 0.1 });
  });

  it("все нули — умолчание, а не деление на ноль", () => {
    const normalized = normalizeWeights({ t: 0, k: 0, h: 0, c: 0, b: 0 });

    expect(normalized.weights.t).toBeCloseTo(0.4, 9);
    expect(normalized.normalized).toBe(true);
  });

  it("ожидаемые очки: Стойкость забега, остальные оси ровно по ожидаемому", () => {
    // 1000 × (0,40 × 2,46 + 0,60)
    expect(expectedPointsOf(2 ** 1.3, PARAMS)).toBe(Math.round(1_000 * (0.4 * 2 ** 1.3 + 0.6)));
    expect(expectedPointsOf(1, PARAMS)).toBe(1_000);
  });
});

describe("честность", () => {
  /** Строка таблицы с достаточным ожидаемым по Сборке: проверяются все оси, кроме Стойкости. */
  const row = expectedRowOf(table(), "average", 10);

  it("индекс выше двух потолков — выброс; ровно два потолка ещё не выброс", () => {
    expect(isOutOfRange({ t: 1, k: 6.01, h: 1, c: 1, b: 1 }, 3, row)).toBe(true);
    expect(isOutOfRange({ t: 1, k: 6, h: 1, c: 1, b: 1 }, 3, row)).toBe(false);
    expect(isOutOfRange({ t: 1, k: 1, h: 6.01, c: 1, b: 1 }, 3, row)).toBe(true);
    expect(isOutOfRange({ t: 1, k: 1, h: 1, c: 6.01, b: 1 }, 3, row)).toBe(true);
    expect(isOutOfRange({ t: 1, k: 1, h: 1, c: 1, b: 7 }, 3, row)).toBe(true);
  });

  it("индекс семь по Натиску — подозрение с причиной axis_out_of_range", () => {
    const input = onTarget(10);
    const indexes = indexesOf({ ...input, enemiesKilled: input.enemiesKilled * 7 });

    expect(isOutOfRange(indexes, 3, row)).toBe(true);
    const verdict = judgeRun(verdictInput({ axisOutOfRange: true }), config().runs);
    expect(verdict.verdict).toBe("suspicious");
    expect(verdict.reasons).toContain("axis_out_of_range");
  });

  it("забег на сорок пять минут при остальных осях по ожиданию выбросом не считается", () => {
    const input = { ...onTarget(20), survivalSec: 45 * 60 };
    const indexes = indexesOf(input);

    // (2700 / 600) ^ 1,3 ≈ 7,1 — выше двух потолков, но Стойкость выбросом не бывает.
    expect(indexes.t).toBeGreaterThan(6);
    expect(isOutOfRange(indexes, 3, expectedRowOf(table(), "average", 20))).toBe(false);
  });

  it("Сборка семь на минуте, где ожидаемая ниже двух, выбросом не считается", () => {
    const early = expectedRowOf(table(), "full", 3);
    expect(early.buildScore).toBeLessThan(2);
    const indexes = indexesOf({ ...onTarget(3, "full"), buildScore: 7 });

    expect(indexes.b).toBe(7);
    expect(isOutOfRange(indexes, 3, early)).toBe(false);
  });

  it("Сборка семь на минуте с достаточным ожидаемым — по-прежнему выброс", () => {
    const input = { ...onTarget(10), buildScore: row.buildScore * 7 };

    expect(isOutOfRange(indexesOf(input), 3, row)).toBe(true);
  });

  it("забег без выброса осей причину не получает", () => {
    expect(judgeRun(verdictInput({ axisOutOfRange: false }), config().runs).reasons).not.toContain("axis_out_of_range");
    expect(judgeRun(verdictInput({}), config().runs).reasons).not.toContain("axis_out_of_range");
  });
});

describe("ключи панели", () => {
  it("умолчания — веса 40/20/20/10/10 процентов, показатель 1,30, потолок 3", () => {
    const defaults = SETTING_LIST.filter((setting) => setting.key.startsWith("rating.") && setting.key !== "rating.since-date");

    expect(Object.fromEntries(defaults.map((setting) => [setting.key, setting.fallback]))).toEqual({
      "rating.weight-endurance": 40,
      "rating.weight-onslaught": 20,
      "rating.weight-hunt": 20,
      "rating.weight-clean": 10,
      "rating.weight-build": 10,
      "rating.endurance-exponent": 130,
      "rating.index-cap": 3,
    });
  });

  it("значения вне пределов схема не принимает", () => {
    expect(SETTINGS.ratingIndexCap.schema.safeParse(0).success).toBe(false);
    expect(SETTINGS.ratingIndexCap.schema.safeParse(2.5).success).toBe(false);
    expect(SETTINGS.ratingWeightHunt.schema.safeParse(-1).success).toBe(false);
    expect(SETTINGS.ratingEnduranceExponent.schema.safeParse(50).success).toBe(false);
  });
});

describe("подсчёт очков забега (RunScorer)", () => {
  function scorer(overrides: Record<string, number> = {}, source: ExpectedTable | null = table(), sink?: EventsSink): RunScorer {
    return new RunScorer({ get: () => source }, panelSettings(overrides), sink ?? null);
  }

  it("забег по ожидаемому: очки около тысячи, стиль, полоса, ожидаемые очки того же забега", () => {
    const scored = scorer().score(onTarget(10));

    expect(scored).not.toBeNull();
    expect(scored?.points).toBeGreaterThanOrEqual(998);
    expect(scored?.points).toBeLessThanOrEqual(1_002);
    expect(scored?.band).toBe("average");
    expect(scored?.style).toBe("t");
    expect(scored?.expectedPoints).toBeGreaterThanOrEqual(998);
    expect(scored?.outOfRange).toBe(false);
  });

  it("рекордный забег на сорок пять минут подозрения не вызывает, очки идут по потолку Стойкости", () => {
    const scored = scorer().score({ ...onTarget(20), survivalSec: 45 * 60 });

    expect(scored?.axes.t).toBeGreaterThan(6);
    expect(scored?.outOfRange).toBe(false);
  });

  it("индексы осей сохраняются с тремя знаками", () => {
    const scored = scorer().score({ ...onTarget(20), enemiesKilled: 7_777 });

    for (const value of Object.values(scored?.axes ?? {})) expect(Math.round(value * 1_000) / 1_000).toBe(value);
  });

  it("полоса берётся по силе: слабый и сильный на одной минуте получают разное ожидаемое", () => {
    const base = onTarget(10);

    const weak = scorer().score({ ...base, power: 0.5 });
    const strong = scorer().score({ ...base, power: 9 });

    expect(weak?.band).toBe("novice");
    expect(strong?.band).toBe("full");
    expect(weak?.points).not.toBe(strong?.points);
  });

  it("ключ панели меняет очки: вес Охоты 50 из 130 вместо 20 из 100", () => {
    const input = { ...onTarget(10), huntLog: [{ rank: "elite" as const, value: 15.5 * 10 * 2, aliveSec: 14.6 }] };

    const byDefault = scorer().score(input);
    const heavy = scorer({ "rating.weight-hunt": 50 }).score(input);

    expect(byDefault?.axes.h).toBeCloseTo(2, 2);
    expect(heavy?.points).toBeGreaterThan(byDefault?.points ?? 0);
  });

  it("показатель Стойкости читается из панели в сотых", () => {
    const input = onTarget(20);

    const steep = scorer({ "rating.endurance-exponent": 200 }).score(input);

    expect(steep?.axes.t).toBeCloseTo(4, 2);
  });

  it("таблица не загрузилась — очков нет, а забегу это не мешает", () => {
    expect(scorer({}, null).score(onTarget(10))).toBeNull();
  });

  it("сбой расчёта не выбрасывается наружу: очков нет", () => {
    const failing = new RunScorer(
      {
        get: () => {
          throw new Error("диск");
        },
      },
      panelSettings(),
      null,
    );

    expect(failing.score(onTarget(10))).toBeNull();
  });

  it("таблица отстала от контента: очки считаются, предупреждение в лог не чаще раза в час", () => {
    const warnings: string[] = [];
    const clock = { value: 1_000_000 };
    const lagging = new RunScorer({ get: () => table() }, panelSettings(), null, { now: () => clock.value, warn: (message) => warnings.push(message) });
    const input = { ...onTarget(10), contentHash: "other" };

    expect(lagging.score(input)).not.toBeNull();
    lagging.score(input);
    expect(warnings).toHaveLength(1);
    clock.value += 61 * 60_000;
    lagging.score(input);
    expect(warnings).toHaveLength(2);
  });

  it("сумма весов не 100 — нормируется и пишет предупреждение", () => {
    const warnings: string[] = [];
    const odd = new RunScorer({ get: () => table() }, panelSettings({ "rating.weight-endurance": 48, "rating.weight-onslaught": 24, "rating.weight-hunt": 24, "rating.weight-clean": 12, "rating.weight-build": 12 }), null, {
      now: () => 0,
      warn: (message) => warnings.push(message),
    });

    const scored = odd.score(onTarget(10));

    expect(scored?.points).toBeGreaterThanOrEqual(998);
    expect(scored?.points).toBeLessThanOrEqual(1_002);
    expect(warnings.some((message) => message.includes("weights_normalized"))).toBe(true);
  });
});

describe("событие run_scored", () => {
  const me: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: "555" };

  it("словарь знает событие; ось и стиль — из известных, поля плоские", () => {
    const { payload } = EVENT_DICTIONARY.run_scored;
    const valid = { runId: "run-00000001", points: 1_240, endurance: 1.1, onslaught: 1.4, hunt: 0.9, clean: 1.2, build: 1, style: "k", strengthBand: "average" };

    expect(payload.safeParse(valid).success).toBe(true);
    expect(payload.safeParse({ ...valid, style: "x" }).success).toBe(false);
    expect(payload.safeParse({ ...valid, points: -1 }).success).toBe(false);
    expect(payload.safeParse({ ...valid, points: 12.5 }).success).toBe(false);
  });

  it("серверное событие уходит в писатель событий строкой, которую принимает словарь, без идентификатора игрока в полезной нагрузке", async () => {
    const written: EventRow[] = [];
    const sink: EventsSink = { write: async (rows) => void written.push(...rows) };
    const live = new RunScorer({ get: () => table() }, panelSettings(), sink);
    const scored = live.score(onTarget(10));
    if (scored === null) throw new Error("очков нет");

    await live.announce(me, "run-00000001", scored);

    expect(written).toHaveLength(1);
    const row = written[0];
    expect(row?.eventType).toBe("run_scored");
    expect(row?.schemaVersion).toBe(EVENT_DICTIONARY.run_scored.version);
    expect(row?.platform).toBe("telegram");
    expect(row?.platformUserId).toBeNull();
    expect(EVENT_DICTIONARY.run_scored.payload.safeParse(row?.payload).success).toBe(true);
    expect(JSON.stringify(row?.payload)).not.toContain(me.accountId);
  });

  it("писатель упал — забегу это не мешает", async () => {
    const sink: EventsSink = {
      write: async () => {
        throw new Error("очередь");
      },
    };
    const live = new RunScorer({ get: () => table() }, panelSettings(), sink);
    const scored = live.score(onTarget(10));
    if (scored === null) throw new Error("очков нет");

    await expect(live.announce(me, "run-00000001", scored)).resolves.toBeUndefined();
  });
});

describe("запись забега с очками", () => {
  function config(): AppConfig {
    return loadAppConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
  }

  function setup(source: ExpectedTable | null = table()) {
    const runs = new MemoryRunsRepository();
    const board = new MemoryLeaderboardStore();
    const roles = new RolesService(config(), new MemoryRolesRepository(), new MemoryAccountRepository());
    const scorer = new RunScorer({ get: () => source }, panelSettings(), null);
    const service = new RunsService(config(), runs, board, roles, new RunsHooks(), new RunContinues(), new RunLoadouts(), ratingRestrictions(runs, board).rating, scorer);
    return { runs, service };
  }

  const me: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: "555" };

  /** Итог по ожидаемому на минуте `minute`, как его присылает клиент после T-0292. */
  function finish(minute: number, patch: Partial<RunFinish> = {}): RunFinish {
    const input = onTarget(minute);
    return runFinishSchema.parse({
      runId: randomUUID(),
      difficultyId: "hard",
      outcome: "died",
      survivalSec: input.survivalSec,
      level: 8 + minute,
      enemiesKilled: Math.round(input.enemiesKilled),
      startingWeaponId: "knife",
      weapons: [{ id: "knife", level: 2 }],
      contentHash: input.contentHash,
      stats: {
        damageTaken: Math.round(input.damageTaken ?? 0),
        xpCollected: 100,
        waveReached: minute,
        topKills: [],
        huntLog: input.huntLog ?? [],
        buildScore: input.buildScore ?? 0,
        power: input.power ?? 2.2,
      },
      ...patch,
    });
  }

  it("ответ записи несёт очки, оси, стиль, полосу и ожидаемые очки", async () => {
    const { service } = setup();

    const result = await service.finish(me, finish(10));

    expect(result.score).not.toBeNull();
    expect(result.score?.points).toBeGreaterThan(900);
    expect(result.score?.points).toBeLessThan(1_100);
    expect(result.score?.band).toBe("average");
    expect(result.score?.style).toBe("t");
    expect(Object.keys(result.score?.axes ?? {}).sort()).toEqual(["b", "c", "h", "k", "t"]);
    expect(result.score?.expectedPoints).toBeGreaterThan(900);
  });

  it("очки лежат в строке забега, а повтор итога отвечает теми же числами", async () => {
    const { runs, service } = setup();
    const run = finish(10);

    const first = await service.finish(me, run);
    const stored = runs.rows.get(run.runId)?.record;
    const second = await service.finish(me, run);

    expect(stored?.score?.points).toBe(first.score?.points);
    expect(stored?.score?.style).toBe(first.score?.style);
    expect(second.score).toEqual(first.score);
  });

  it("исходные числа подсчёта лежат в строке: пересчёт обходится без клиента", async () => {
    const { runs, service } = setup();
    const run = finish(10);

    await service.finish(me, run);

    expect(runs.rows.get(run.runId)?.record?.scoreInput).toMatchObject({ power: 2.2, buildScore: 6 });
  });

  it("не рейтинговая сложность (пролог и обучение) — без очков", async () => {
    const { runs, service } = setup();
    const run = finish(3, { difficultyId: "easy" });

    const result = await service.finish(me, run);

    expect(result.score).toBeUndefined();
    expect(runs.rows.get(run.runId)?.record?.score).toBeNull();
  });

  it("таблица не загрузилась — забег записан, очки null", async () => {
    const { runs, service } = setup(null);
    const run = finish(10);

    const result = await service.finish(me, run);

    expect(result.verdict).toBe("ok");
    expect(result.score).toBeUndefined();
    expect(runs.rows.get(run.runId)?.status).toBe("finished");
  });

  it("выброс оси — забег подозрителен, не идёт в рейтинг и ждёт разбора", async () => {
    const { runs, service } = setup();
    // Сборка в семь раз выше ожидаемого: больше ничто в забеге порогов не пробивает.
    const run = finish(10);
    if (run.stats !== undefined) run.stats.buildScore = 42;

    const result = await service.finish(me, run);

    expect(result.verdict).toBe("suspicious");
    expect(result.recorded).toBe(false);
    // Без старта время не проверено (unverified_time) — вердикт оно не меняет.
    expect(runs.rows.get(run.runId)?.record?.verdictReasons).toEqual(["unverified_time", "axis_out_of_range"]);
  });

  it("клиент прошлой сборки без журнала охоты, оценки сборки и силы — очки считаются по средней полосе", async () => {
    const { service } = setup();
    const legacy = finish(10);
    delete legacy.stats?.huntLog;
    delete legacy.stats?.buildScore;
    delete legacy.stats?.power;

    const result = await service.finish(me, legacy);

    expect(result.score?.band).toBe("average");
    expect(result.score?.axes.h).toBe(1);
    expect(result.score?.axes.b).toBe(1);
  });

  it("схема приёма принимает силу в stats и отвергает отрицательную", () => {
    const run = finish(10);

    expect(runFinishSchema.safeParse(run).success).toBe(true);
    expect(runFinishSchema.safeParse({ ...run, stats: { ...run.stats, power: -1 } }).success).toBe(false);
  });
});

function config(): AppConfig {
  return loadAppConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
}

function verdictInput(patch: Partial<VerdictInput>): VerdictInput {
  return {
    survivalSec: 600,
    level: 12,
    enemiesKilled: 6_000,
    weaponCount: 2,
    contentHash: "abc",
    startedAtMs: 0,
    finishedAtMs: 600_000,
    continues: 0,
    paidContinues: 0,
    underpaidContinues: false,
    cheats: false,
    loadout: "none",
    boosts: "none",
    counters: null,
    ...patch,
  };
}
