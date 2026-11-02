import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sanitizeLoadout } from "../src/game/progression/run-loadout";
import {
  buildExpectedTable,
  EXPECTED_BAND_IDS,
  EXPECTED_MINUTES,
  expectedBandLoadouts,
  expectedBandOf,
  expectedRowOf,
  findExpectedTableProblems,
  loadoutPower,
  POWER_PROFILES,
  simulateBalanceRun,
  type BalanceRunResult,
  type ExpectedTable,
} from "../src/game/balance";

// Таблица ожидаемого E(S, t) для очков эффективности (tasks/T-0291, Р152,
// design/art/meta-v2.md §2.2): медианы прогонов бота по полосам силы и минутам.
// Её читает сервер (T-0293), поэтому форма и порядок строк — договор.

/** Прогон с заданными счётчиками; всё остальное — нейтральные значения. */
function run(partial: Partial<BalanceRunResult>): BalanceRunResult {
  return {
    seed: 1,
    skill: "dodging",
    startingWeaponId: "spark",
    survivalSec: 0,
    level: 1,
    wave: 1,
    enemiesKilled: 0,
    xpCollected: 0,
    peakEnemies: 0,
    firstLevelUpSec: 0,
    chestsFound: 0,
    chestsOpened: 0,
    evolutions: 0,
    buildCompleteSec: 0,
    buildPicks: 0,
    timedOut: false,
    damageTakenByMinute: [],
    startPower: 0,
    startPressure: 1,
    endPressure: 1,
    buildScoreByMinute: [],
    killsByMinute: [],
    huntLogCountByMinute: [],
    buildPointsByMinute: [],
    huntLog: [],
    ...partial,
  };
}

/** Прогон, прожитый `minutes` полных минут: все помесячные массивы одной длины. */
function lived(minutes: number, fields: { kills: number[]; damage: number[]; hunt?: number[]; build: number[]; log?: BalanceRunResult["huntLog"] }): BalanceRunResult {
  return run({
    survivalSec: minutes * 60 + 5,
    killsByMinute: fields.kills,
    damageTakenByMinute: fields.damage,
    huntLogCountByMinute: fields.hunt ?? fields.kills.map(() => 0),
    buildPointsByMinute: fields.build,
    huntLog: fields.log ?? [],
  });
}

describe("сборка таблицы из прогонов", () => {
  it("строка (полоса, минута): накопленное к минуте, делённое на минуты, и медиана по прогонам", () => {
    // Три прогона по две минуты. Убийства накопленные: к 1-й минуте 60/120/180, ко 2-й 200/400/600.
    const runs = [
      lived(2, { kills: [60, 200], damage: [10, 30], build: [1, 2] }),
      lived(2, { kills: [120, 400], damage: [20, 40], build: [2, 3] }),
      lived(2, { kills: [180, 600], damage: [30, 50], build: [3, 4] }),
    ];
    const table = buildExpectedTable({ contentHash: "h", generatedAt: "t", minutes: 2, bands: [{ id: "average", power: 2, runs }] });
    const [first, second] = table.rows;

    expect(first).toMatchObject({ band: "average", minute: 1, killsPerMin: 120, damageTakenPerMin: 20, buildScore: 2 });
    // 2-я минута: накопленное 200/400/600 за две минуты — 100/200/300 в минуту.
    expect(second).toMatchObject({ band: "average", minute: 2, killsPerMin: 200, buildScore: 3 });
    // Урон накопленный: 10+30=40, 20+40=60, 30+50=80 за две минуты — 20/30/40 в минуту.
    expect(second.damageTakenPerMin).toBe(30);
  });

  it("охота: ценность убитых к минуте в минуту, время жизни — медиана по рангам", () => {
    const log = [
      { rank: "elite" as const, value: 10, aliveSec: 20 },
      { rank: "boss" as const, value: 40, aliveSec: 60 },
      { rank: "elite" as const, value: 10, aliveSec: 999 },
    ];
    // К 1-й минуте убита первая запись, ко 2-й — две, к 3-й — все три.
    const only = lived(3, { kills: [1, 2, 3], damage: [0, 0, 0], hunt: [1, 2, 3], build: [0, 0, 0], log });
    const table = buildExpectedTable({ contentHash: "h", generatedAt: "t", minutes: 3, bands: [{ id: "average", power: 2, runs: [only] }] });

    expect(table.rows[0]).toMatchObject({ huntPerMin: 10, huntKillSec: { elite: 20, boss: 0 } });
    expect(table.rows[1]).toMatchObject({ huntPerMin: 25, huntKillSec: { elite: 20, boss: 60 } });
    expect(table.rows[2].huntPerMin).toBeCloseTo(20, 9);
    // Элит двое: 20 и 999 — медиана по квантилю проекта берёт верхнюю.
    expect(table.rows[2].huntKillSec).toEqual({ elite: 999, boss: 60 });
  });

  it("минута без данных берёт значение последней минуты с данными той же полосы", () => {
    const short = lived(2, { kills: [60, 240], damage: [5, 5], build: [1, 3] });
    const table = buildExpectedTable({ contentHash: "h", generatedAt: "t", minutes: 4, bands: [{ id: "average", power: 2, runs: [short] }] });

    expect(table.rows).toHaveLength(4);
    expect(table.rows[2]).toEqual({ ...table.rows[1], minute: 3 });
    expect(table.rows[3]).toEqual({ ...table.rows[1], minute: 4 });
  });

  it("прогон, не дожившего до минуты, в её строку не входит", () => {
    const strong = lived(3, { kills: [60, 120, 180], damage: [1, 1, 1], build: [1, 2, 3] });
    const weak = lived(1, { kills: [600], damage: [1], build: [9] });
    const table = buildExpectedTable({ contentHash: "h", generatedAt: "t", minutes: 3, bands: [{ id: "average", power: 2, runs: [strong, weak] }] });

    // На 1-й минуте оба: медиана верхняя из 60 и 600. На 2-й и 3-й — один сильный.
    expect(table.rows[0].killsPerMin).toBe(600);
    expect(table.rows[1].killsPerMin).toBe(60);
    expect(table.rows[2].buildScore).toBe(3);
  });

  it("нет данных вовсе — нули, а не пропуск строки", () => {
    const table = buildExpectedTable({ contentHash: "h", generatedAt: "t", minutes: 2, bands: [{ id: "average", power: 2, runs: [run({ survivalSec: 10 })] }] });

    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toEqual({ band: "average", minute: 1, killsPerMin: 0, huntPerMin: 0, huntKillSec: { elite: 0, boss: 0 }, damageTakenPerMin: 0, buildScore: 0 });
  });

  it("полосы идут в порядке входа, строки — полоса за полосой по минутам, поля шапки сохранены", () => {
    const runs = [lived(2, { kills: [60, 120], damage: [1, 1], build: [1, 1] })];
    const table = buildExpectedTable({
      contentHash: "abc",
      generatedAt: "2026-10-25T00:00:00.000Z",
      minutes: 2,
      bands: [
        { id: "novice", power: 1, runs },
        { id: "novice_average", power: 2, runs },
        { id: "average", power: 3, runs },
      ],
    });

    expect(table.version).toBe(1);
    expect(table.contentHash).toBe("abc");
    expect(table.generatedAt).toBe("2026-10-25T00:00:00.000Z");
    expect(table.rows.map((row) => `${row.band}:${row.minute}`)).toEqual([
      "novice:1", "novice:2", "novice_average:1", "novice_average:2", "average:1", "average:2",
    ]);
  });

  it("границы полос — середины между соседними центрами, первая полоса с нуля, последняя без верха", () => {
    const runs = [lived(1, { kills: [60], damage: [1], build: [1] })];
    const table = buildExpectedTable({
      contentHash: "h",
      generatedAt: "t",
      minutes: 1,
      bands: [
        { id: "novice", power: 1, runs },
        { id: "novice_average", power: 3, runs },
        { id: "average", power: 7, runs },
      ],
    });

    expect(table.bands).toEqual([
      { id: "novice", fromPower: 0, toPower: 2 },
      { id: "novice_average", fromPower: 2, toPower: 5 },
      { id: "average", fromPower: 5, toPower: null },
    ]);
  });

  it("без числа минут берётся 20", () => {
    const table = buildExpectedTable({ contentHash: "h", generatedAt: "t", bands: [{ id: "average", power: 2, runs: [] }] });
    expect(table.rows).toHaveLength(EXPECTED_MINUTES);
    expect(EXPECTED_MINUTES).toBe(20);
  });
});

describe("поиск строки по силе и минуте", () => {
  const runs = [lived(3, { kills: [60, 120, 180], damage: [1, 1, 1], build: [1, 2, 3] })];
  const table = buildExpectedTable({
    contentHash: "h",
    generatedAt: "t",
    minutes: 3,
    bands: EXPECTED_BAND_IDS.map((id, index) => ({ id, power: 1 + index * 2, runs })),
  });

  it("полоса — по границам: нижняя граница входит, верхняя уже в следующей", () => {
    // Центры 1, 3, 5, 7, 9 — границы 2, 4, 6, 8.
    expect(expectedBandOf(table.bands, 1.99).id).toBe("novice");
    expect(expectedBandOf(table.bands, 2).id).toBe("novice_average");
    expect(expectedBandOf(table.bands, 7.99).id).toBe("average_full");
    expect(expectedBandOf(table.bands, 8).id).toBe("full");
    expect(expectedBandOf(table.bands, 500).id).toBe("full");
  });

  it("силы нет — полоса «средний», ниже нуля — первая", () => {
    expect(expectedBandOf(table.bands, undefined).id).toBe("average");
    expect(expectedBandOf(table.bands, -3).id).toBe("novice");
  });

  it("минута за пределами таблицы зажимается: меньше первой и больше последней", () => {
    expect(expectedRowOf(table, 5, 0).minute).toBe(1);
    expect(expectedRowOf(table, 5, 99).minute).toBe(3);
    expect(expectedRowOf(table, 5, 2)).toMatchObject({ band: "average", minute: 2, killsPerMin: 60 });
  });
});

describe("полосы силы по профилям T-0196", () => {
  const bands = expectedBandLoadouts();

  it("пять полос в порядке: новичок, между, средний, между, полный", () => {
    expect(bands.map((band) => band.id)).toEqual(["novice", "novice_average", "average", "average_full", "full"]);
    expect(bands[0].loadout).toEqual(POWER_PROFILES.novice.loadout);
    expect(bands[2].loadout).toEqual(POWER_PROFILES.average.loadout);
    expect(bands[4].loadout).toEqual(POWER_PROFILES.full.loadout);
  });

  it("промежуточные — среднее соседей: снаряжение пополам, уровень между, бусты не раньше сильного профиля", () => {
    const [, low, , high] = bands;
    expect(low.loadout.modifiers.damage).toBeCloseTo((POWER_PROFILES.average.loadout.modifiers.damage ?? 0) / 2, 3);
    expect(low.loadout.accountLevel).toBeGreaterThan(1);
    expect(low.loadout.accountLevel).toBeLessThan(8);
    expect(low.loadout.boosts).toEqual([]);
    expect(high.loadout.accountLevel).toBeGreaterThan(8);
    expect(high.loadout.accountLevel).toBeLessThan(POWER_PROFILES.full.loadout.accountLevel ?? 0);
    expect(high.loadout.boosts.length).toBeLessThan(POWER_PROFILES.full.loadout.boosts.length);
    for (const boost of high.loadout.boosts) expect(POWER_PROFILES.full.loadout.boosts).toContain(boost);
  });

  it("пределы движка ничего не срезают у промежуточных наборов", () => {
    for (const band of bands) expect(sanitizeLoadout(band.loadout), band.id).toEqual(band.loadout);
  });

  it("сила строго растёт от полосы к полосе", () => {
    const powers = bands.map((band) => loadoutPower(band.loadout));
    for (let i = 1; i < powers.length; i++) expect(powers[i], bands[i].id).toBeGreaterThan(powers[i - 1]);
  });
});

describe("малый прогон: 2 зерна, 3 минуты", () => {
  const bandIds = ["novice", "full"] as const;
  const profiles = [POWER_PROFILES.novice, POWER_PROFILES.full];
  const table = buildExpectedTable({
    contentHash: "test",
    generatedAt: "t",
    minutes: 3,
    bands: profiles.map((profile, index) => ({
      id: bandIds[index],
      power: loadoutPower(profile.loadout),
      runs: [1, 2].map((seed) => simulateBalanceRun({ seed, skill: "dodging", maxSec: 200, loadout: profile.loadout })),
    })),
  });

  it("форма строк: все поля числа, минуты подряд, значения не отрицательны", () => {
    expect(table.rows).toHaveLength(6);
    for (const row of table.rows) {
      for (const value of [row.killsPerMin, row.huntPerMin, row.huntKillSec.elite, row.huntKillSec.boss, row.damageTakenPerMin, row.buildScore]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
    expect(table.rows.map((row) => row.minute)).toEqual([1, 2, 3, 1, 2, 3]);
    expect(table.rows.map((row) => row.band)).toEqual(["novice", "novice", "novice", "full", "full", "full"]);
  });

  it("полосы по возрастанию силы, а проверка схемы не находит замечаний", () => {
    expect(table.bands[0].fromPower).toBeLessThan(table.bands[1].fromPower);
    expect(findExpectedTableProblems(table, { bands: 2, minutes: 3 })).toEqual([]);
  });

  it("бот убивает врагов: к третьей минуте темп убийств не нулевой", () => {
    expect(table.rows[2].killsPerMin).toBeGreaterThan(0);
  });
});

describe("проверка схемы таблицы", () => {
  const runs = [lived(2, { kills: [60, 120], damage: [1, 1], build: [1, 1] })];
  const good = (): ExpectedTable =>
    buildExpectedTable({
      contentHash: "h",
      generatedAt: "t",
      minutes: 2,
      bands: [
        { id: "novice", power: 1, runs },
        { id: "average", power: 3, runs },
      ],
    });
  const options = { bands: 2, minutes: 2 };

  it("исправная таблица замечаний не даёт", () => {
    expect(findExpectedTableProblems(good(), options)).toEqual([]);
  });

  it("fromPower не растёт — замечание называет полосу", () => {
    const table = good();
    table.bands[1].fromPower = table.bands[0].fromPower;
    expect(findExpectedTableProblems(table, options).join("\n")).toContain("average");
  });

  it("не хватает строки — замечание называет число строк", () => {
    const table = good();
    table.rows.pop();
    expect(findExpectedTableProblems(table, options).join("\n")).toContain("строк");
  });

  it("строка с неизвестной полосой или отрицательным числом — замечание", () => {
    const stray = good();
    stray.rows[0].band = "ghost";
    expect(findExpectedTableProblems(stray, options).join("\n")).toContain("ghost");

    const negative = good();
    negative.rows[1].killsPerMin = -1;
    expect(findExpectedTableProblems(negative, options).join("\n")).toContain("killsPerMin");
  });

  it("пустой хэш контента — замечание", () => {
    const table = good();
    table.contentHash = "";
    expect(findExpectedTableProblems(table, options).join("\n")).toContain("contentHash");
  });
});

describe("файл таблицы у сервера", () => {
  const path = fileURLToPath(new URL("../../../backend/api/src/modules/rating/expected-runs.json", import.meta.url));
  const table = JSON.parse(readFileSync(path, "utf8")) as ExpectedTable;

  it("проходит свою схему: пять полос, двадцать минут", () => {
    expect(findExpectedTableProblems(table)).toEqual([]);
    expect(table.bands.map((band) => band.id)).toEqual([...EXPECTED_BAND_IDS]);
    expect(table.rows).toHaveLength(5 * EXPECTED_MINUTES);
  });

  it("у пяти полос fromPower растёт", () => {
    for (let i = 1; i < table.bands.length; i++) {
      expect(table.bands[i].fromPower, table.bands[i].id).toBeGreaterThan(table.bands[i - 1].fromPower);
    }
  });

  it("несёт отпечаток контента и версию формата", () => {
    expect(table.version).toBe(1);
    expect(table.contentHash).toMatch(/^[0-9a-f]+$/);
  });
});
