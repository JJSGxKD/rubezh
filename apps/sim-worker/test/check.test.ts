import { ACCOUNT_UNLOCKS, BASE_WEAPONS, CONTENT_SNAPSHOT, TIMELINE, unlocksAt } from "@bh/core-game";
import { quantile, simulateBalanceRun, summarizeRuns, type BalanceRunResult } from "@bh/core-game/src/game/balance";
import { describe, expect, it, vi } from "vitest";
import { defaultScenarios, runCheck } from "../src/check";
import { DEFAULT_SEEDS, SNAPSHOT_MAX_BYTES } from "../src/limits";

// Проверка черновика контента в воркере (docs/35-stage4-plan.md Р15,
// tasks/T-0302): схема, проверки контента, симуляция сценариев против
// базы. Те же функции и зёрна, что у `pnpm balance:sim`.

/** Снимок так, как он приходит из очереди: JSON без общих ссылок. */
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const DEFAULT_JSON = json(CONTENT_SNAPSHOT);
/** Черновик, который отличается от базы: у него прогоны считаются отдельно. */
const CHANGED_JSON = json({ ...CONTENT_SNAPSHOT, maxBoostsPerRun: CONTENT_SNAPSHOT.maxBoostsPerRun + 1 });

/** Настоящий прогон бота — секунды, а не миллисекунды: тесты на нём получают свой предел. */
const REAL_RUNS_MS = 180_000;

/** Подмена прогона: считает вызовы и «тратит» время часов. */
function fakeRun(tickMs = 0) {
  const clock = { at: 0 };
  const calls: { seed: number; skill: string }[] = [];
  const simulate = (options: { seed: number; skill: string }): BalanceRunResult => {
    calls.push({ seed: options.seed, skill: options.skill });
    clock.at += tickMs;
    return { seed: options.seed, skill: "dodging", startingWeaponId: "w", survivalSec: 100 + options.seed, level: 3, wave: 2, enemiesKilled: 50, xpCollected: 10, peakEnemies: 9, firstLevelUpSec: 10, chestsFound: 1, chestsOpened: 1, evolutions: 0, timedOut: false };
  };
  return { clock, calls, simulate: simulate as never };
}

describe("испорченное и слишком большое", () => {
  it("снимок не по схеме — проблемы схемы с путями, проверок контента и симуляции нет", async () => {
    const run = fakeRun();
    const broken = { ...(DEFAULT_JSON as Record<string, unknown>), enemies: "не массив", maxBoostsPerRun: "много" };

    const result = await runCheck({ checkId: "c-1", snapshot: broken, baseSnapshot: DEFAULT_JSON, scenarios: [] }, { simulate: run.simulate });

    expect(result.checkId).toBe("c-1");
    expect(result.report).toBeNull();
    expect(result.contentProblems).toEqual([]);
    expect(run.calls).toHaveLength(0);
    expect(result.schemaProblems.map((problem) => problem.path)).toEqual(expect.arrayContaining(["enemies", "maxBoostsPerRun"]));
    for (const problem of result.schemaProblems) expect(problem.message.length).toBeGreaterThan(0);
  });

  it("база не по схеме тоже останавливает проверку, а путь назван от базы", async () => {
    const run = fakeRun();
    const result = await runCheck({ checkId: "c-2", snapshot: DEFAULT_JSON, baseSnapshot: { schemaVersion: 2 }, scenarios: [] }, { simulate: run.simulate });
    expect(result.report).toBeNull();
    expect(run.calls).toHaveLength(0);
    expect(result.schemaProblems.length).toBeGreaterThan(0);
    for (const problem of result.schemaProblems) expect(problem.path.startsWith("baseSnapshot")).toBe(true);
  });

  it("снимок больше 2 МБ отклоняется до разбора схемой", async () => {
    const run = fakeRun();
    const huge = { ...(DEFAULT_JSON as Record<string, unknown>), padding: "я".repeat(SNAPSHOT_MAX_BYTES) };
    const result = await runCheck({ checkId: "c-3", snapshot: huge, baseSnapshot: DEFAULT_JSON, scenarios: [] }, { simulate: run.simulate });
    expect(result.schemaProblems).toEqual([{ path: "snapshot", message: "Снимок больше 2 МБ" }]);
    expect(result.report).toBeNull();
    expect(run.calls).toHaveLength(0);
  });

  it("само задание без идентификатора или с лишним полем — исключение, а не отчёт", async () => {
    await expect(runCheck({ snapshot: DEFAULT_JSON, baseSnapshot: DEFAULT_JSON, scenarios: [] })).rejects.toThrow();
    await expect(runCheck({ checkId: "c", snapshot: DEFAULT_JSON, baseSnapshot: DEFAULT_JSON, scenarios: [], extra: 1 })).rejects.toThrow();
    await expect(runCheck({ checkId: "bad:id", snapshot: DEFAULT_JSON, baseSnapshot: DEFAULT_JSON, scenarios: [] })).rejects.toThrow();
  });

  it("проблемы контента называются, а симуляция всё равно идёт: правка не должна терять отчёт из-за одного замечания", async () => {
    const run = fakeRun();
    const draft = json(CONTENT_SNAPSHOT) as { timeline: { fromSec: number }[] };
    // Пустое число элит в таймлайне: проверка «первый сундук» обязана это назвать.
    const noEvents = { ...draft, timeline: draft.timeline.map((segment) => ({ ...segment, events: [] })) };

    const result = await runCheck({ checkId: "c-4", snapshot: noEvents, baseSnapshot: DEFAULT_JSON, scenarios: [{ id: "один", skill: "dodging", seeds: 1 }] }, { simulate: run.simulate });

    expect(result.schemaProblems).toEqual([]);
    expect(result.contentProblems.length).toBeGreaterThan(0);
    expect(result.contentProblems[0]).toHaveProperty("path");
    expect(result.contentProblems[0]).toHaveProperty("message");
    expect(result.report).not.toBeNull();
    expect(run.calls.length).toBeGreaterThan(0);
  });
});

describe("отчёт по умолчанию", () => {
  it("снимок-умолчание против себя — нулевые дельты по каждому сценарию", async () => {
    const result = await runCheck({ checkId: "d-1", snapshot: DEFAULT_JSON, baseSnapshot: DEFAULT_JSON, scenarios: [], seeds: 2 });

    expect(result.schemaProblems).toEqual([]);
    expect(result.contentProblems).toEqual([]);
    const report = result.report;
    expect(report).not.toBeNull();
    expect(report?.timeout).toBe(false);
    expect(report?.scenarios.length).toBeGreaterThan(1);
    for (const scenario of report?.scenarios ?? []) {
      expect(scenario.error).toBeNull();
      expect(scenario.skipped).toBe(false);
      expect(scenario.draft).toEqual(scenario.base);
      expect(Object.values(scenario.delta ?? {})).toEqual([0, 0, 0, 0, 0]);
    }
    for (const corridor of report?.corridors ?? []) expect(corridor.draft?.verdict).toBe(corridor.base?.verdict);
  }, REAL_RUNS_MS);

  it("тот же контент в другом порядке ключей (так его отдаёт jsonb) — те же медианы, нулевые дельты, а не «другая версия»", async () => {
    const sorted = (value: unknown): unknown =>
      Array.isArray(value) ? value.map(sorted) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)])) : value;
    const scenarios = [
      { id: "пассивный", skill: "passive" as const, seeds: 2 },
      { id: "уклоняющийся", skill: "dodging" as const, seeds: 1 },
    ];

    const result = await runCheck({ checkId: "d-4", snapshot: DEFAULT_JSON, baseSnapshot: sorted(DEFAULT_JSON), scenarios });

    for (const scenario of result.report?.scenarios ?? []) expect(Object.values(scenario.delta ?? {})).toEqual([0, 0, 0, 0, 0]);
  }, REAL_RUNS_MS);

  it("совпадает с balance:sim: те же сценарии, зёрна 1…N, те же медианы (2 зерна)", async () => {
    const result = await runCheck({ checkId: "d-2", snapshot: DEFAULT_JSON, baseSnapshot: DEFAULT_JSON, scenarios: [], seeds: 2 });

    // Сценарии — как собирает свод калибровки: пассивный на первом стартовом оружии, уклоняющийся на каждом.
    const firstLevel = unlocksAt(ACCOUNT_UNLOCKS, 1).weapons;
    const starting = BASE_WEAPONS.filter((weapon) => firstLevel.has(weapon.id)).map((weapon) => weapon.id);
    const expected = [{ skill: "passive" as const, startingWeaponId: starting[0] as string }, ...starting.map((id) => ({ skill: "dodging" as const, startingWeaponId: id }))];

    const scenarios = result.report?.scenarios ?? [];
    expect(scenarios.map((scenario) => [scenario.skill, scenario.startingWeaponId])).toEqual(expected.map((item) => [item.skill, item.startingWeaponId]));
    expect(scenarios.map((scenario) => scenario.id)).toEqual(expected.map((item) => `${item.skill} / ${item.startingWeaponId}`));

    for (const [index, item] of expected.entries()) {
      const runs = [1, 2].map((seed) => simulateBalanceRun({ ...item, difficultyId: "easy", seed }));
      const summary = summarizeRuns(runs);
      const kills = runs.map((run) => run.enemiesKilled).sort((a, b) => a - b);
      expect(scenarios[index]?.draft).toEqual({
        survivalSec: summary.medianSurvivalSec,
        firstLevelUpSec: summary.medianFirstLevelUpSec,
        level: summary.medianLevel,
        kills: quantile(kills, 0.5),
        chestsOpened: summary.medianChestsOpened,
      });
    }
  }, REAL_RUNS_MS);

  it("зёрна по умолчанию — двадцать, как у balance:sim; набор по умолчанию строится по базе", () => {
    expect(DEFAULT_SEEDS).toBe(20);
    const scenarios = defaultScenarios(CONTENT_SNAPSHOT);
    expect(scenarios[0]).toMatchObject({ skill: "passive", difficultyId: "easy" });
    expect(scenarios.slice(1).every((scenario) => scenario.skill === "dodging")).toBe(true);
  });

  it("коридоры снимка: пять строк, у каждой вердикт черновика и базы; правка коридора меняет вердикт только черновика", async () => {
    const draft = json({ ...CONTENT_SNAPSHOT, balanceTargets: { ...CONTENT_SNAPSHOT.balanceTargets, dodgingMedianSec: { min: 1_000_000, max: 2_000_000 }, firstChestEventSec: { min: 1, max: 10 } } });
    const scenarios = [
      { id: "пассивный", skill: "passive" as const, seeds: 2 },
      { id: "уклоняющийся", skill: "dodging" as const, seeds: 2 },
    ];

    const result = await runCheck({ checkId: "d-3", snapshot: draft, baseSnapshot: DEFAULT_JSON, scenarios });

    const corridors = new Map((result.report?.corridors ?? []).map((corridor) => [corridor.id, corridor]));
    expect([...corridors.keys()]).toEqual(["passiveDeathBeforeSec", "dodgingMedianSec", "dodgingDeathsBeforeMinuteRatioMax", "firstLevelUpSec", "firstChestEventSec"]);
    // Медиана бота — секунды, а коридор черновика — миллионы: «ниже».
    expect(corridors.get("dodgingMedianSec")?.draft?.verdict).toBe("below");
    expect(corridors.get("dodgingMedianSec")?.corridor).toEqual({ min: 1_000_000, max: 2_000_000 });
    expect(corridors.get("dodgingMedianSec")?.baseCorridor).toEqual({ min: CONTENT_SNAPSHOT.balanceTargets.dodgingMedianSec.min, max: CONTENT_SNAPSHOT.balanceTargets.dodgingMedianSec.max });
    // Контент один, значит и медиана на черновике и на базе одна; различается только коридор.
    expect(corridors.get("dodgingMedianSec")?.draft?.value).toBe(corridors.get("dodgingMedianSec")?.base?.value);
    // Первое событие элиты в таймлайне — на 90-й секунде: вне коридора 1…10 — «выше»; в коридоре 60…120 базы — «в коридоре».
    const first = Math.min(...TIMELINE.filter((segment) => (segment.events ?? []).some((event) => CONTENT_SNAPSHOT.enemies.find((enemy) => enemy.id === event.enemy)?.rank !== undefined)).map((segment) => segment.fromSec));
    expect(corridors.get("firstChestEventSec")?.draft).toEqual({ value: first, verdict: "above" });
    expect(corridors.get("firstChestEventSec")?.base).toEqual({ value: first, verdict: "in" });
  }, REAL_RUNS_MS);
});

describe("сценарии задания", () => {
  it("свои сценарии идут вместо набора по умолчанию, у каждого свои зёрна; на каждом — черновик и база", async () => {
    const run = fakeRun();
    const result = await runCheck(
      {
        checkId: "s-1",
        snapshot: CHANGED_JSON,
        baseSnapshot: DEFAULT_JSON,
        scenarios: [
          { id: "a", skill: "dodging", seeds: 3 },
          { id: "b", skill: "passive", difficultyId: "easy", seeds: 2 },
        ],
      },
      { simulate: run.simulate },
    );
    expect(result.report?.scenarios.map((scenario) => scenario.id)).toEqual(["a", "b"]);
    // (3 + 2) зерна на черновике и столько же на базе.
    expect(run.calls).toHaveLength(10);
    expect(result.report?.scenarios[0]?.draft?.survivalSec).toBe(102);
  });

  it("зёрна идут с 1 подряд — те же, что у balance:sim", async () => {
    const run = fakeRun();
    await runCheck({ checkId: "s-2", snapshot: CHANGED_JSON, baseSnapshot: DEFAULT_JSON, scenarios: [{ id: "a", skill: "dodging", seeds: 4 }] }, { simulate: run.simulate });
    expect(run.calls.map((call) => call.seed)).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
  });

  it("сценарий, который на черновике падает, помечен ошибкой, а остальные считаются", async () => {
    const run = fakeRun();
    const simulate = ((options: { seed: number; skill: string; startingWeaponId?: string }) => {
      if (options.startingWeaponId === "нет_такого") throw new Error("оружие не найдено");
      return (run.simulate as unknown as (o: unknown) => BalanceRunResult)(options);
    }) as never;

    const result = await runCheck(
      {
        checkId: "s-3",
        snapshot: CHANGED_JSON,
        baseSnapshot: DEFAULT_JSON,
        scenarios: [
          { id: "плохой", skill: "dodging", startingWeaponId: "нет_такого", seeds: 1 },
          { id: "хороший", skill: "dodging", seeds: 1 },
        ],
      },
      { simulate },
    );

    const [bad, good] = result.report?.scenarios ?? [];
    expect(bad?.error).toContain("оружие не найдено");
    expect(bad?.draft).toBeNull();
    expect(bad?.delta).toBeNull();
    expect(good?.error).toBeNull();
    expect(good?.draft).not.toBeNull();
  });

  it("сложности, которой нет в снимке, — ошибка сценария, а не молчаливая «Лёгкая»", async () => {
    const run = fakeRun();
    const result = await runCheck({ checkId: "s-4", snapshot: CHANGED_JSON, baseSnapshot: DEFAULT_JSON, scenarios: [{ id: "a", skill: "dodging", difficultyId: "nightmare", seeds: 1 }] }, { simulate: run.simulate });
    expect(result.report?.scenarios[0]?.error).toContain("nightmare");
    expect(run.calls).toHaveLength(0);
  });

  it("прогоны базы одной версии считаются один раз: повторное задание берёт их из кэша", async () => {
    const run = fakeRun();
    const baseRuns = new Map<string, BalanceRunResult[]>();
    const job = { checkId: "k-1", snapshot: CHANGED_JSON, baseSnapshot: DEFAULT_JSON, scenarios: [{ id: "a", skill: "dodging" as const, seeds: 3 }] };

    await runCheck(job, { simulate: run.simulate, baseRuns });
    expect(run.calls).toHaveLength(6);
    await runCheck({ ...job, checkId: "k-2" }, { simulate: run.simulate, baseRuns });
    expect(run.calls).toHaveLength(9);
  });

  it("другая база — другие прогоны: кэш по содержимому, а не по номеру задания", async () => {
    const run = fakeRun();
    const baseRuns = new Map<string, BalanceRunResult[]>();
    const other = json({ ...CONTENT_SNAPSHOT, maxBoostsPerRun: CONTENT_SNAPSHOT.maxBoostsPerRun + 2 });
    const scenarios = [{ id: "a", skill: "dodging" as const, seeds: 2 }];
    await runCheck({ checkId: "k-3", snapshot: CHANGED_JSON, baseSnapshot: DEFAULT_JSON, scenarios }, { simulate: run.simulate, baseRuns });
    await runCheck({ checkId: "k-4", snapshot: CHANGED_JSON, baseSnapshot: other, scenarios }, { simulate: run.simulate, baseRuns });
    expect(run.calls).toHaveLength(8);
  });

  it("черновик, равный базе, считается один раз: забег детерминирован, и прогоны базы — те же самые", async () => {
    const run = fakeRun();
    const baseRuns = new Map<string, BalanceRunResult[]>();
    const result = await runCheck({ checkId: "k-5", snapshot: DEFAULT_JSON, baseSnapshot: DEFAULT_JSON, scenarios: [{ id: "a", skill: "dodging", seeds: 3 }] }, { simulate: run.simulate, baseRuns });
    expect(run.calls).toHaveLength(3);
    expect(result.report?.scenarios[0]?.delta).toEqual({ survivalSec: 0, firstLevelUpSec: 0, level: 0, kills: 0, chestsOpened: 0 });
    // Они же ложатся в кэш базы: следующий черновик на той же базе их уже не пересчитает.
    await runCheck({ checkId: "k-6", snapshot: CHANGED_JSON, baseSnapshot: DEFAULT_JSON, scenarios: [{ id: "a", skill: "dodging", seeds: 3 }] }, { simulate: run.simulate, baseRuns });
    expect(run.calls).toHaveLength(6);
  });
});

describe("предел времени", () => {
  it("прогон дольше предела — timeout в отчёте, дальше не считаем; что не успело, помечено", async () => {
    const run = fakeRun(40);
    const result = await runCheck(
      {
        checkId: "t-1",
        snapshot: CHANGED_JSON,
        baseSnapshot: DEFAULT_JSON,
        scenarios: [
          { id: "первый", skill: "dodging", seeds: 1 },
          { id: "второй", skill: "dodging", seeds: 5 },
          { id: "третий", skill: "passive", seeds: 1 },
        ],
      },
      { simulate: run.simulate, limitMs: 100, now: () => run.clock.at },
    );

    expect(result.report?.timeout).toBe(true);
    // Первый сценарий уложился (два прогона по 40 мс), на втором предел вышел.
    expect(run.calls.length).toBeLessThanOrEqual(4);
    const [first, second, third] = result.report?.scenarios ?? [];
    expect(first?.skipped).toBe(false);
    expect(first?.draft).not.toBeNull();
    expect(second?.skipped).toBe(true);
    expect(second?.draft).toBeNull();
    expect(third?.skipped).toBe(true);
  });

  it("уложились — timeout ложен, ничего не пропущено", async () => {
    const run = fakeRun(1);
    const result = await runCheck({ checkId: "t-2", snapshot: CHANGED_JSON, baseSnapshot: DEFAULT_JSON, scenarios: [{ id: "a", skill: "dodging", seeds: 2 }] }, { simulate: run.simulate, limitMs: 1_000, now: () => run.clock.at });
    expect(result.report?.timeout).toBe(false);
    expect(result.report?.scenarios.every((scenario) => !scenario.skipped)).toBe(true);
  });

  it("между прогонами воркер отдаёт управление циклу событий — иначе очередь сочтёт задание зависшим", async () => {
    const run = fakeRun();
    const yieldToLoop = vi.fn(async () => undefined);
    await runCheck({ checkId: "t-3", snapshot: CHANGED_JSON, baseSnapshot: DEFAULT_JSON, scenarios: [{ id: "a", skill: "dodging", seeds: 3 }] }, { simulate: run.simulate, yieldToLoop });
    expect(yieldToLoop.mock.calls.length).toBeGreaterThanOrEqual(run.calls.length);
  });
});
