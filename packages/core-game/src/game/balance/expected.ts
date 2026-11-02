import { LOADOUT_STATS, type RunHuntEntry, type RunLoadout } from "@bh/shared-types";
import { MAPS } from "../../content/maps";
import { createRunWorld } from "../run-world";
import { POWER_PROFILES } from "./power-profiles";
import { quantile, type BalanceRunResult } from "./simulate";

/**
 * Таблица ожидаемого `E(S, t)` для очков эффективности (Р152, tasks/T-0291,
 * design/art/meta-v2.md §2.2): медианы прогонов бота по полосам силы и
 * минутам забега. Сервер не гоняет симуляцию на каждый забег, а берёт число
 * из этой таблицы (`backend/api/src/modules/rating/expected-runs.json`,
 * T-0293), поэтому форма таблицы и порядок строк — договор с сервером.
 *
 * Функции здесь чистые: прогоны делает скрипт `scripts/balance/expected-table.ts`.
 */

/** Сколько минут в таблице: дальше сервер берёт значение 20-й минуты. */
export const EXPECTED_MINUTES = 20;

/** Версия формата файла: сервер сверяет её при загрузке. */
export const EXPECTED_TABLE_VERSION = 1;

/** Пять полос силы по возрастанию: три профиля T-0196 и середины между ними. */
export const EXPECTED_BAND_IDS = ["novice", "novice_average", "average", "average_full", "full"] as const;
export type ExpectedBandId = (typeof EXPECTED_BAND_IDS)[number];

/** Полоса, в которую попадает забег без поля силы (подстройки не было). */
export const FALLBACK_BAND_ID: ExpectedBandId = "average";

/**
 * Полоса силы: `[fromPower, toPower)`. У первой полосы нижняя граница — ноль,
 * у последней верхней нет (`null`): ниже первой и выше последней силе
 * достаётся крайняя полоса.
 */
export interface ExpectedBand {
  id: string;
  fromPower: number;
  toPower: number | null;
}

export interface ExpectedRow {
  /** `id` полосы из `bands` */
  band: string;
  /** от 1 до `EXPECTED_MINUTES` */
  minute: number;
  /** убийств в минуту: накопленное к концу минуты, делённое на минуты */
  killsPerMin: number;
  /** ценность убитых элит и боссов в минуту: `xp` убитого, накопленное к минуте */
  huntPerMin: number;
  /** время жизни до смерти, секунды: по рангам; 0 — такого убитого ещё не было ни у одного прогона полосы */
  huntKillSec: { elite: number; boss: number };
  /** полученного урона в минуту, накопленное к минуте */
  damageTakenPerMin: number;
  /** оценка сборки итога на этой минуте: эволюции × 2 + оружие и навыки на максимуме */
  buildScore: number;
}

export interface ExpectedTable {
  version: number;
  /** `CONTENT_HASH` на момент сборки: по нему сервер видит, что таблица отстала от контента */
  contentHash: string;
  generatedAt: string;
  bands: ExpectedBand[];
  /** полоса за полосой, внутри полосы минуты по возрастанию */
  rows: ExpectedRow[];
}

export interface ExpectedBandRuns {
  id: string;
  /** сила центра полосы в очках (как `pressure.power` итога) */
  power: number;
  runs: readonly BalanceRunResult[];
}

export interface BuildExpectedOptions {
  contentHash: string;
  generatedAt: string;
  bands: readonly ExpectedBandRuns[];
  /** по умолчанию — `EXPECTED_MINUTES`; меньше нужно только малому прогону теста */
  minutes?: number;
}

/** Сотые, как сила в итоге забега (`toHundredths` в `sim/pressure.ts`). */
function hundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Медиана по квантилю проекта, до тысячных: файл таблицы читает человек, и дробный хвост в диффе — шум. */
function sortedMedian(values: number[]): number {
  return Math.round(quantile([...values].sort((a, b) => a - b), 0.5) * 1000) / 1000;
}

/** Сколько полных минут прожил прогон: по нему он попадает в строки минут. */
function fullMinutes(run: BalanceRunResult): number {
  return run.killsByMinute.length;
}

interface Cell {
  killsPerMin: number;
  huntPerMin: number;
  /** `null` — убитых такого ранга у прогонов минуты нет */
  huntKillSec: { elite: number | null; boss: number | null };
  damageTakenPerMin: number;
  buildScore: number;
}

/** Ячейка минуты `minute` по прогонам, дожившим до неё; `null` — таких прогонов нет. */
function cellOf(runs: readonly BalanceRunResult[], minute: number): Cell | null {
  const reached = runs.filter((run) => fullMinutes(run) >= minute);
  if (reached.length === 0) return null;

  const kills: number[] = [];
  const hunt: number[] = [];
  const damage: number[] = [];
  const build: number[] = [];
  const alive = { elite: [] as number[], boss: [] as number[] };
  for (const run of reached) {
    kills.push(run.killsByMinute[minute - 1] / minute);
    let damageSum = 0;
    for (let i = 0; i < minute; i++) damageSum += run.damageTakenByMinute[i] ?? 0;
    damage.push(damageSum / minute);
    build.push(run.buildPointsByMinute[minute - 1] ?? 0);

    const killed: readonly RunHuntEntry[] = run.huntLog.slice(0, run.huntLogCountByMinute[minute - 1] ?? 0);
    let value = 0;
    for (const entry of killed) {
      value += entry.value;
      alive[entry.rank].push(entry.aliveSec);
    }
    hunt.push(value / minute);
  }

  return {
    killsPerMin: sortedMedian(kills),
    huntPerMin: sortedMedian(hunt),
    huntKillSec: {
      elite: alive.elite.length === 0 ? null : sortedMedian(alive.elite),
      boss: alive.boss.length === 0 ? null : sortedMedian(alive.boss),
    },
    damageTakenPerMin: sortedMedian(damage),
    buildScore: sortedMedian(build),
  };
}

/**
 * Строки одной полосы. Минута, до которой не дожил ни один прогон, берёт
 * значение последней минуты с данными; время жизни по рангу переносится так
 * же по минутам, где убитых этого ранга ещё не было.
 */
function rowsOf(band: ExpectedBandRuns, minutes: number): ExpectedRow[] {
  const rows: ExpectedRow[] = [];
  let last: ExpectedRow | null = null;
  let lastElite = 0;
  let lastBoss = 0;
  for (let minute = 1; minute <= minutes; minute++) {
    const cell = cellOf(band.runs, minute);
    let row: ExpectedRow;
    if (cell === null) {
      row = last === null
        ? { band: band.id, minute, killsPerMin: 0, huntPerMin: 0, huntKillSec: { elite: 0, boss: 0 }, damageTakenPerMin: 0, buildScore: 0 }
        : { ...last, minute, huntKillSec: { ...last.huntKillSec } };
    } else {
      lastElite = cell.huntKillSec.elite ?? lastElite;
      lastBoss = cell.huntKillSec.boss ?? lastBoss;
      row = {
        band: band.id,
        minute,
        killsPerMin: cell.killsPerMin,
        huntPerMin: cell.huntPerMin,
        huntKillSec: { elite: lastElite, boss: lastBoss },
        damageTakenPerMin: cell.damageTakenPerMin,
        buildScore: cell.buildScore,
      };
    }
    rows.push(row);
    last = row;
  }
  return rows;
}

/** Таблица из прогонов: полосы по центрам силы, строки — медианы. */
export function buildExpectedTable(options: BuildExpectedOptions): ExpectedTable {
  const minutes = options.minutes ?? EXPECTED_MINUTES;
  const bands: ExpectedBand[] = options.bands.map((band, index) => {
    const next = options.bands[index + 1];
    return {
      id: band.id,
      // Граница полосы — середина между соседними центрами; первая полоса идёт от нуля.
      fromPower: index === 0 ? 0 : hundredths((options.bands[index - 1].power + band.power) / 2),
      toPower: next === undefined ? null : hundredths((band.power + next.power) / 2),
    };
  });
  return {
    version: EXPECTED_TABLE_VERSION,
    contentHash: options.contentHash,
    generatedAt: options.generatedAt,
    bands,
    rows: options.bands.flatMap((band) => rowsOf(band, minutes)),
  };
}

/**
 * Полоса по силе игрока из итога забега. Нет силы (подстройки не было) —
 * полоса «средний»; ниже первой границы — первая, выше последней — последняя.
 */
export function expectedBandOf(bands: readonly ExpectedBand[], power: number | undefined): ExpectedBand {
  if (power === undefined) {
    const fallback = bands.find((band) => band.id === FALLBACK_BAND_ID);
    if (fallback !== undefined) return fallback;
  }
  let found = bands[0];
  for (const band of bands) {
    if (power !== undefined && power >= band.fromPower) found = band;
  }
  return found;
}

/** Строка для силы и минуты; минута вне таблицы зажимается в её пределы. */
export function expectedRowOf(table: ExpectedTable, power: number | undefined, minute: number): ExpectedRow {
  const band = expectedBandOf(table.bands, power);
  const rows = table.rows.filter((row) => row.band === band.id);
  const wanted = Math.min(Math.max(1, Math.round(minute)), rows[rows.length - 1].minute);
  return rows.find((row) => row.minute === wanted) ?? rows[rows.length - 1];
}

export interface ExpectedBandLoadout {
  id: ExpectedBandId;
  loadout: RunLoadout;
}

/**
 * Набор для прогона промежуточной полосы: снаряжение пополам, уровень
 * аккаунта посередине, из бустов — половина бустов сильного профиля (в силу
 * они не входят, но бой меняют).
 */
function midLoadout(low: RunLoadout, high: RunLoadout): RunLoadout {
  const modifiers: RunLoadout["modifiers"] = {};
  for (const stat of LOADOUT_STATS) {
    const value = round4(((low.modifiers[stat] ?? 0) + (high.modifiers[stat] ?? 0)) / 2);
    if (value !== 0) modifiers[stat] = value;
  }
  return {
    modifiers,
    boosts: high.boosts.slice(0, Math.floor(high.boosts.length / 2)),
    accountLevel: Math.round(((low.accountLevel ?? 1) + (high.accountLevel ?? 1)) / 2),
  };
}

/** Наборы пяти полос по возрастанию силы: профили T-0196 и середины между ними. */
export function expectedBandLoadouts(): ExpectedBandLoadout[] {
  const { novice, average, full } = POWER_PROFILES;
  return [
    { id: "novice", loadout: novice.loadout },
    { id: "novice_average", loadout: midLoadout(novice.loadout, average.loadout) },
    { id: "average", loadout: average.loadout },
    { id: "average_full", loadout: midLoadout(average.loadout, full.loadout) },
    { id: "full", loadout: full.loadout },
  ];
}

/**
 * Сила набора на старте забега в очках — то, что движок пишет в
 * `pressure.power` итога. Не зависит ни от зерна, ни от оружия.
 */
export function loadoutPower(loadout: RunLoadout): number {
  const { world } = createRunWorld({ seed: 1, mapId: MAPS[0].id, difficultyId: "hard", unitScale: 1, loadout });
  return hundredths(world.difficulty.startPower);
}

export interface ExpectedTableShape {
  bands: number;
  minutes: number;
}

/**
 * Замечания к таблице: форма, порядок полос, строки. Пусто — таблицу можно
 * отдавать серверу. Ожидаемую форму задаёт вызывающий; умолчание — боевая.
 */
export function findExpectedTableProblems(
  table: ExpectedTable,
  shape: ExpectedTableShape = { bands: EXPECTED_BAND_IDS.length, minutes: EXPECTED_MINUTES },
): string[] {
  const problems: string[] = [];
  if (table.version !== EXPECTED_TABLE_VERSION) problems.push(`version ${table.version}, ожидалась ${EXPECTED_TABLE_VERSION}`);
  if (typeof table.contentHash !== "string" || table.contentHash === "") problems.push("contentHash пуст");
  if (typeof table.generatedAt !== "string" || table.generatedAt === "") problems.push("generatedAt пуст");
  if (table.bands.length !== shape.bands) problems.push(`полос ${table.bands.length}, ожидалось ${shape.bands}`);

  table.bands.forEach((band, index) => {
    if (index === 0) return;
    if (!(band.fromPower > table.bands[index - 1].fromPower)) {
      problems.push(`полоса ${band.id}: fromPower ${band.fromPower} не больше, чем у ${table.bands[index - 1].id}`);
    }
  });

  const expectedRows = shape.bands * shape.minutes;
  if (table.rows.length !== expectedRows) problems.push(`строк ${table.rows.length}, ожидалось ${expectedRows}`);

  const known = new Set(table.bands.map((band) => band.id));
  table.rows.forEach((row, index) => {
    const where = `строка ${index} (${row.band}, ${row.minute})`;
    if (!known.has(row.band)) problems.push(`${where}: неизвестная полоса ${row.band}`);
    const expectedMinute = (index % shape.minutes) + 1;
    if (row.minute !== expectedMinute) problems.push(`${where}: минута ${row.minute}, ожидалась ${expectedMinute}`);
    const numbers: [string, number][] = [
      ["killsPerMin", row.killsPerMin],
      ["huntPerMin", row.huntPerMin],
      ["huntKillSec.elite", row.huntKillSec.elite],
      ["huntKillSec.boss", row.huntKillSec.boss],
      ["damageTakenPerMin", row.damageTakenPerMin],
      ["buildScore", row.buildScore],
    ];
    for (const [name, value] of numbers) {
      if (!Number.isFinite(value) || value < 0) problems.push(`${where}: ${name} = ${value}`);
    }
  });
  return problems;
}
