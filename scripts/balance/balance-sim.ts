import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { BALANCE_TARGETS, BUILD_COMPLETE_TARGETS, buildCompleteCorridorSec, MODIFIER_TARGETS, PRESSURE_TARGETS } from "../../packages/core-game/src/content/balance-targets";
import { PRESSURE } from "../../packages/core-game/src/content/pressure";
import { createRunWorld } from "../../packages/core-game/src/game/run-world";
import { buildScoreOf } from "../../packages/core-game/src/game/sim/player-power";
import { DIFFICULTIES } from "../../packages/core-game/src/content/difficulty";
import { RUN_MODIFIERS } from "../../packages/core-game/src/content/modifiers";
import { ENEMY_STAGES } from "../../packages/core-game/src/content/stages";
import { ENDLESS_CURVE, TIMELINE } from "../../packages/core-game/src/content/waves";
import { ACCOUNT_UNLOCKS } from "../../packages/core-game/src/content/unlocks";
import { BASE_WEAPONS } from "../../packages/core-game/src/content/weapons";
import { unlocksAt } from "../../packages/core-game/src/game/progression/unlocks";
import {
  POWER_PROFILES,
  quantile,
  simulateBalanceRun,
  summarizeRuns,
  withDevice,
  type BalanceRunResult,
  type BotSkill,
  type PowerProfile,
} from "../../packages/core-game/src/game/balance";

/**
 * Прогон калибровки баланса: `pnpm balance:sim`
 * (docs/26-stage2-plan.md, WP4.6).
 *
 * N seed × стартовые оружия × уровни бота — и распределение времени выживания
 * в таблице, которую читает геймдизайнер. Это не тест: он ничего не
 * утверждает и не падает. Свойства баланса, которые обязаны выполняться
 * всегда, проверяет `balance-properties.test.ts` в обычном прогоне.
 *
 * Запускается отдельным конфигом vitest, а не входит в `pnpm test`: полный
 * свод — это десятки секунд симуляции, и гонять его на каждом коммите незачем.
 */

const SEEDS = 20;
const REPORT_PATH = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  "var",
  "balance",
  "balance-sim.md",
);

type DifficultyId = (typeof DIFFICULTIES)[number]["id"];

interface Scenario {
  skill: BotSkill;
  startingWeaponId: string;
  difficultyId: DifficultyId;
}

/**
 * Коридоры калибровки заданы для «Сложной» — главного боя (Р126). «Лёгкая»
 * идёт строками обучающего забега со своим блоком коридоров, «Нормальная» —
 * справочно: геймдизайнеру нужно видеть, насколько они мягче, а не проверять
 * их тем же коридором.
 */
const BASE_DIFFICULTY_ID: DifficultyId = "hard";

/** Зонд давления: seed на оружие, потолок прогона и ширина окна урона. */
const PRESSURE_SEEDS = 10;
const PRESSURE_MAX_SEC = 1020;
const PRESSURE_WINDOW_MIN = 3;

/** Сборка набора: seed и оружие. Прогон до сборки, потолок — из коридора. */
const BUILD_SEEDS = 10;
const BUILD_WEAPON_ID = "spark";

it("свод калибровки баланса", () => {
  const scenarios = buildScenarios();
  const rows: string[] = [];
  const byScenario = new Map<string, BalanceRunResult[]>();

  for (const scenario of scenarios) {
    const runs: BalanceRunResult[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      runs.push(simulateBalanceRun({ ...scenario, seed }));
    }
    const suffix = scenario.difficultyId === BASE_DIFFICULTY_ID ? "" : ` / ${scenario.difficultyId}`;
    byScenario.set(`${scenario.skill} / ${scenario.startingWeaponId}${suffix}`, runs);
  }

  rows.push("# Свод калибровки баланса");
  rows.push("");
  rows.push(`Seed на сценарий: ${SEEDS}. Отпечаток контента — в итоге каждого забега.`);
  rows.push("");
  rows.push("| Сценарий | медиана, с | p10 | p90 | до минуты | уровень | волна | 1-й уровень, с | сундуков | эволюций |");
  rows.push("|---|---|---|---|---|---|---|---|---|---|");

  for (const [name, runs] of byScenario) {
    const summary = summarizeRuns(runs);
    rows.push(
      `| ${name} | ${fixed(summary.medianSurvivalSec)} | ${fixed(summary.p10SurvivalSec)} | ` +
        `${fixed(summary.p90SurvivalSec)} | ${percent(summary.deathsBeforeMinuteRatio)} | ` +
        `${summary.medianLevel} | ${summary.medianWave} | ${fixed(summary.medianFirstLevelUpSec)} | ` +
        `${summary.medianChestsOpened} | ${summary.medianEvolutions} |`,
    );
  }

  rows.push("");
  rows.push(...corridorLines(byScenario));
  rows.push("");
  rows.push(...pressureLines());
  rows.push("");
  rows.push(...buildLines());
  rows.push("");
  rows.push(...levelLines());

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${rows.join("\n")}\n`, "utf8");
  console.log(rows.join("\n"));
  console.log(`\nТаблица сохранена: ${REPORT_PATH}`);
});

// Подстройка под силу — отдельным тестом: калибровка гоняет только её (`-t "подстройка"`),
// а не весь свод на двадцати seed. Таблица пишется в свой файл рядом со сводом.
it("подстройка под силу и расписание сборки", { timeout: 1_800_000 }, () => {
  const rows = [...powerLines(), "", ...scheduleLines()];
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  const powerPath = join(dirname(REPORT_PATH), "balance-power.md");
  writeFileSync(powerPath, `${rows.join("\n")}\n`, "utf8");
  console.log(rows.join("\n"));
  console.log(`\nТаблица сохранена: ${powerPath}`);
});

// Модификаторы забега (T-0119, Р105): отдельным тестом, как подстройка, — калибровка
// гоняет только их (`-t "модификаторы"`). Строки: «Сложная» без модификатора и с каждым.
it("модификаторы забега", { timeout: 1_800_000 }, () => {
  const rows = modifierLines();
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  const modifierPath = join(dirname(REPORT_PATH), "balance-modifiers.md");
  writeFileSync(modifierPath, `${rows.join("\n")}\n`, "utf8");
  console.log(rows.join("\n"));
  console.log(`\nТаблица сохранена: ${modifierPath}`);
});

function buildScenarios(): Scenario[] {
  // Оружие первого уровня аккаунта: с ним приходит новичок, и эталоны
  // сценариев набраны на нём (docs/35-stage4-plan.md §3.13).
  const firstLevel = unlocksAt(ACCOUNT_UNLOCKS, 1).weapons;
  const starting = BASE_WEAPONS.filter((weapon) => firstLevel.has(weapon.id)).map((weapon) => weapon.id);
  const scenarios: Scenario[] = [];

  // Пассивный прогоняется на одном оружии: он всё равно не стреляет осмысленно,
  // а отвечает на единственный вопрос — умирает ли игрок, который ничего не
  // делает.
  scenarios.push({ skill: "passive", startingWeaponId: starting[0], difficultyId: BASE_DIFFICULTY_ID });
  for (const difficulty of DIFFICULTIES) {
    for (const startingWeaponId of starting) {
      scenarios.push({ skill: "dodging", startingWeaponId, difficultyId: difficulty.id });
    }
  }
  return scenarios;
}

/**
 * Сверка с коридорами, зафиксированными до калибровки. Строки отчёта, а не
 * падение прогона: попадание в коридор — предмет решения геймдизайнера, и
 * останавливать им сборку нельзя.
 */
function corridorLines(byScenario: ReadonlyMap<string, BalanceRunResult[]>): string[] {
  const lines = ["## Коридоры", ""];
  const dodging: BalanceRunResult[] = [];
  let passive: BalanceRunResult[] = [];

  for (const [name, runs] of byScenario) {
    if (isOtherDifficulty(name)) continue;
    if (name.startsWith("passive")) passive = runs;
    else dodging.push(...runs);
  }

  const passiveSummary = summarizeRuns(passive);
  const dodgingSummary = summarizeRuns(dodging);
  const target = BALANCE_TARGETS;

  lines.push(
    verdict(
      `пассивный умирает до ${target.passiveDeathBeforeSec} с`,
      passiveSummary.p90SurvivalSec < target.passiveDeathBeforeSec,
      `p90 = ${fixed(passiveSummary.p90SurvivalSec)} с`,
    ),
  );
  lines.push(
    verdict(
      `медиана уклоняющегося в ${target.dodgingMedianSec.min}–${target.dodgingMedianSec.max} с`,
      dodgingSummary.medianSurvivalSec >= target.dodgingMedianSec.min &&
        dodgingSummary.medianSurvivalSec <= target.dodgingMedianSec.max,
      `${fixed(dodgingSummary.medianSurvivalSec)} с`,
    ),
  );
  lines.push(
    verdict(
      `смертей до минуты не больше ${percent(target.dodgingDeathsBeforeMinuteRatioMax)}`,
      dodgingSummary.deathsBeforeMinuteRatio <= target.dodgingDeathsBeforeMinuteRatioMax,
      percent(dodgingSummary.deathsBeforeMinuteRatio),
    ),
  );
  lines.push(
    verdict(
      `первый уровень в ${target.firstLevelUpSec.min}–${target.firstLevelUpSec.max} с`,
      dodgingSummary.medianFirstLevelUpSec >= target.firstLevelUpSec.min &&
        dodgingSummary.medianFirstLevelUpSec <= target.firstLevelUpSec.max,
      `${fixed(dodgingSummary.medianFirstLevelUpSec)} с`,
    ),
  );

  // Рубеж на 10:00 (T-0120): доли — по всем забегам уклоняющегося бота на «Сложной».
  const reached = dodging.filter((run) => run.rubezh?.reached === true).length / Math.max(1, dodging.length);
  const cleared = dodging.filter((run) => run.rubezh?.clearedSec != null).length / Math.max(1, dodging.length);
  lines.push(
    verdict(
      `дошёл до рубежа не больше ${percent(target.rubezh.reachedRatioMax)}`,
      reached <= target.rubezh.reachedRatioMax,
      percent(reached),
    ),
  );
  lines.push(
    verdict(
      `взял рубеж не больше ${percent(target.rubezh.clearedRatioMax)}`,
      cleared <= target.rubezh.clearedRatioMax,
      percent(cleared),
    ),
  );

  // Свод по всем сценариям прячет сильный перекос: одно удачное стартовое
  // оружие вытягивает медиану за два слабых. Разбор по сценариям — отдельно.
  lines.push("", "## Перекос по стартовым оружиям", "");
  for (const [name, runs] of byScenario) {
    if (name.startsWith("passive") || isOtherDifficulty(name)) continue;
    const summary = summarizeRuns(runs);
    const inCorridor =
      summary.medianFirstLevelUpSec >= target.firstLevelUpSec.min &&
      summary.medianFirstLevelUpSec <= target.firstLevelUpSec.max;
    if (inCorridor) continue;
    // Ноль означает «уровень не взят ни разу», а не «взят мгновенно».
    const when =
      summary.medianFirstLevelUpSec === 0
        ? "первый уровень не берётся вовсе"
        : `первый уровень на ${fixed(summary.medianFirstLevelUpSec)} с`;
    lines.push(`- ${name}: ${when}, медианный уровень ${summary.medianLevel}`);
  }
  return lines;
}

/**
 * Индекс силы врага на секунде `sec` — формула теста контента: здоровье и
 * урон «Сложной» на кривой, умноженные на средневзвешенный `hpMul × damageMul`
 * открытых ступеней. До начала кривой растёт только ступень.
 */
function strengthAt(sec: number): number {
  const hard = DIFFICULTIES.find((difficulty) => difficulty.id === BASE_DIFFICULTY_ID);
  if (hard === undefined) return 0;
  const steps = Math.max(0, Math.floor((sec - ENDLESS_CURVE.fromSec) / ENDLESS_CURVE.segmentSec));
  let hp = hard.enemyHpMul;
  let damage = hard.enemyDamageMul;
  for (let i = 0; i < steps; i++) {
    hp *= ENDLESS_CURVE.hpGrowth;
    damage *= ENDLESS_CURVE.damageGrowth;
  }
  let weight = 0;
  let weighted = 0;
  for (const stage of ENEMY_STAGES) {
    if (stage.fromSec > sec) break;
    weight += stage.weight;
    weighted += stage.weight * stage.hpMul * stage.damageMul;
  }
  return (hp * damage * weighted) / weight;
}

/**
 * Зонд давления: бессмертный уклоняющийся бот идёт до 17-й минуты, таблица
 * показывает урон, который он получил за каждые три минуты, и медианный
 * индекс силы врага того же окна. Раздел ничего не утверждает и не падает:
 * бот на «Сложной» до восьмой минуты не доживает, и поздний бой иначе не
 * увидеть (tasks/T-0192, решение 6).
 */
function pressureLines(): string[] {
  const firstLevel = unlocksAt(ACCOUNT_UNLOCKS, 1).weapons;
  const starting = BASE_WEAPONS.filter((weapon) => firstLevel.has(weapon.id)).map((weapon) => weapon.id);
  const runs: BalanceRunResult[] = [];
  for (const startingWeaponId of starting) {
    for (let seed = 1; seed <= PRESSURE_SEEDS; seed++) {
      runs.push(
        simulateBalanceRun({ seed, skill: "dodging", startingWeaponId, difficultyId: BASE_DIFFICULTY_ID, immortalPlayer: true, maxSec: PRESSURE_MAX_SEC }),
      );
    }
  }

  const lines = [
    "## Давление после 8-й минуты",
    "",
    `Бессмертный уклоняющийся бот, «${BASE_DIFFICULTY_ID}», ${PRESSURE_SEEDS} seed × ${starting.length} оружия, до ${PRESSURE_MAX_SEC / 60} мин. Урон — за окно целиком.`,
    "",
    "| Окно, мин | медиана урона | p90 урона | индекс силы врага |",
    "|---|---|---|---|",
  ];
  for (let from = 0; from * 60 < PRESSURE_MAX_SEC; from += PRESSURE_WINDOW_MIN) {
    const to = Math.min(from + PRESSURE_WINDOW_MIN, Math.floor(PRESSURE_MAX_SEC / 60));
    if (to <= from) break;
    const damages = runs
      .filter((run) => run.damageTakenByMinute.length >= to)
      .map((run) => run.damageTakenByMinute.slice(from, to).reduce((sum, value) => sum + value, 0))
      .sort((a, b) => a - b);
    lines.push(
      `| ${from}–${to} | ${fixed(quantile(damages, 0.5))} | ${fixed(quantile(damages, 0.9))} | ${fixed(strengthAt(((from + to) / 2) * 60))} |`,
    );
  }
  return lines;
}

/**
 * Сборка набора (Р127, tasks/T-0193): бессмертный уклоняющийся бот на «Сложной»
 * идёт, пока все слоты не заняты и не доведены до максимума. Коридор
 * относительный — во сколько раз позже, чем у того же бота до правок: секунды
 * бота с минутами человека не сравниваются (`BUILD_COMPLETE_TARGETS`).
 */
function buildLines(): string[] {
  const targets = BUILD_COMPLETE_TARGETS;
  const corridor = buildCompleteCorridorSec();
  const maxSec = Math.ceil(corridor.max * targets.buildCompleteHorizon);
  const runs: BalanceRunResult[] = [];
  for (let seed = 1; seed <= BUILD_SEEDS; seed++) {
    runs.push(
      simulateBalanceRun({
        seed,
        skill: "dodging",
        startingWeaponId: BUILD_WEAPON_ID,
        difficultyId: BASE_DIFFICULTY_ID,
        godMode: true,
        stopOnBuild: true,
        maxSec,
      }),
    );
  }
  const summary = summarizeRuns(runs);
  const built = runs.filter((run) => run.buildCompleteSec > 0).sort((a, b) => a.buildCompleteSec - b.buildCompleteSec);
  const times = built.map((run) => run.buildCompleteSec);
  const picks = built.map((run) => run.buildPicks).sort((a, b) => a - b);

  const lines = [
    "## Сборка набора (Р127)",
    "",
    `Бессмертный уклоняющийся бот, «${BASE_DIFFICULTY_ID}», «${BUILD_WEAPON_ID}», ${BUILD_SEEDS} seed, до ${maxSec} с. ` +
      `База до правок — ${fixed(targets.buildCompleteBaselineSec)} с, коридор ×${targets.buildCompleteRatio.min}–×${targets.buildCompleteRatio.max} = ` +
      `${fixed(corridor.min)}–${fixed(corridor.max)} с.`,
    "",
    "| медиана, с | p10 | p90 | собрали | выборов до сборки (медиана) | во сколько раз позже базы |",
    "|---|---|---|---|---|---|",
    `| ${fixed(summary.medianBuildCompleteSec)} | ${fixed(quantile(times, 0.1))} | ${fixed(quantile(times, 0.9))} | ` +
      `${percent(summary.buildCompleteRatio)} | ${quantile(picks, 0.5)} | ×${(summary.medianBuildCompleteSec / targets.buildCompleteBaselineSec).toFixed(2)} |`,
    "",
  ];
  lines.push(
    verdict(
      `медиана сборки в ${fixed(corridor.min)}–${fixed(corridor.max)} с`,
      summary.medianBuildCompleteSec >= corridor.min && summary.medianBuildCompleteSec <= corridor.max,
      `${fixed(summary.medianBuildCompleteSec)} с`,
    ),
  );
  lines.push(
    verdict(
      `набор собрали не менее ${percent(targets.buildCompleteShareMin)} seed`,
      summary.buildCompleteRatio >= targets.buildCompleteShareMin,
      percent(summary.buildCompleteRatio),
    ),
  );
  return lines;
}

/** Подстройка под силу: seed на оружие и потолок прогона (бот профиля живёт дольше базового). */
const POWER_SEEDS = 15;
const POWER_MAX_SEC = 1800;

/** Сетка расписания сборки: секунды и округление до 0,05 (T-0196, решение 3.1). */
const SCHEDULE_GRID_SEC = [0, 120, 300, 600, 900, 1200];
const SCHEDULE_SEEDS = 10;

/** Сколько врагов приходит самым крупным событием таймлайна и кривой, вместе с содержимым кольца стражей. */
function largestEventSize(): number {
  const sizeOf = (event: { count: number; ring?: { inner?: { count: number }[] } }): number =>
    event.count + (event.ring?.inner ?? []).reduce((sum, inner) => sum + inner.count, 0);
  const events = [...TIMELINE.flatMap((segment) => segment.events ?? []), ...ENDLESS_CURVE.events];
  return Math.max(0, ...events.map(sizeOf));
}

/** Стартовые оружия первого уровня аккаунта: с ними приходит новичок. */
function startingWeapons(): string[] {
  const firstLevel = unlocksAt(ACCOUNT_UNLOCKS, 1).weapons;
  return BASE_WEAPONS.filter((weapon) => firstLevel.has(weapon.id)).map((weapon) => weapon.id);
}

/**
 * Подстройка под силу (Р131, Р183, tasks/T-0196): три профиля силы на
 * «Сложной» с подстройкой и без неё, и «средний» на слабом устройстве. Таблица
 * и вердикты по коридорам `PRESSURE_TARGETS`; последняя строка — отношения
 * соседних профилей, по ним проверяется «не больше половины преимущества».
 */
function powerLines(): string[] {
  const targets = PRESSURE_TARGETS;
  const weapons = startingWeapons();
  const rowsOf = (profile: PowerProfile, options: { pressure: boolean; light?: boolean }): BalanceRunResult[] => {
    const runs: BalanceRunResult[] = [];
    const loadout = options.light === true ? withDevice(profile, "light").loadout : profile.loadout;
    for (const startingWeaponId of weapons) {
      for (let seed = 1; seed <= POWER_SEEDS; seed++) {
        runs.push(
          simulateBalanceRun({ seed, skill: "dodging", startingWeaponId, difficultyId: BASE_DIFFICULTY_ID, maxSec: POWER_MAX_SEC, loadout, pressure: options.pressure }),
        );
      }
    }
    return runs;
  };

  const { novice, average, full } = POWER_PROFILES;
  const results = {
    noviceOn: rowsOf(novice, { pressure: true }),
    noviceOff: rowsOf(novice, { pressure: false }),
    averageOn: rowsOf(average, { pressure: true }),
    averageOff: rowsOf(average, { pressure: false }),
    fullOn: rowsOf(full, { pressure: true }),
    fullOff: rowsOf(full, { pressure: false }),
    averageLight: rowsOf(average, { pressure: true, light: true }),
  };
  const baselineRuns: BalanceRunResult[] = [];
  for (const startingWeaponId of weapons) {
    for (let seed = 1; seed <= POWER_SEEDS; seed++) {
      baselineRuns.push(simulateBalanceRun({ seed, skill: "dodging", startingWeaponId, difficultyId: BASE_DIFFICULTY_ID, maxSec: POWER_MAX_SEC }));
    }
  }

  const lines = [
    "## Подстройка под силу (Р131)",
    "",
    `Уклоняющийся бот, «${BASE_DIFFICULTY_ID}», ${POWER_SEEDS} seed × ${weapons.length} оружия. «Без подстройки» — тот же набор, давление единой сложности. ` +
      `L — уровень давления на старте и в конце (медианы).`,
    "",
    "| Профиль | медиана, с | p10 | p90 | пик врагов (медиана / макс) | L старт | L конец |",
    "|---|---|---|---|---|---|---|",
  ];
  const medians: Record<string, number> = {};
  const addRow = (name: string, runs: BalanceRunResult[]): void => {
    const summary = summarizeRuns(runs);
    medians[name] = summary.medianSurvivalSec;
    const peaks = runs.map((run) => run.peakEnemies).sort((a, b) => a - b);
    const start = runs.map((run) => run.startPressure).sort((a, b) => a - b);
    const end = runs.map((run) => run.endPressure).sort((a, b) => a - b);
    lines.push(
      `| ${name} | ${fixed(summary.medianSurvivalSec)} | ${fixed(summary.p10SurvivalSec)} | ${fixed(summary.p90SurvivalSec)} | ` +
        `${quantile(peaks, 0.5)} / ${peaks[peaks.length - 1] ?? 0} | ${quantile(start, 0.5).toFixed(2)} | ${quantile(end, 0.5).toFixed(2)} |`,
    );
  };
  addRow("без набора (база)", baselineRuns);
  addRow("новичок, без подстройки", results.noviceOff);
  addRow("новичок", results.noviceOn);
  addRow("средний, без подстройки", results.averageOff);
  addRow("средний", results.averageOn);
  addRow("полный арсенал, без подстройки", results.fullOff);
  addRow("полный арсенал", results.fullOn);
  addRow("средний, слабое устройство", results.averageLight);

  const ratio = (a: string, b: string): number => (medians[b] === 0 || medians[b] === undefined ? 0 : (medians[a] ?? 0) / medians[b]);
  const between = (value: number, range: { min: number; max: number }): boolean => value >= range.min && value <= range.max;
  const noviceToAverage = ratio("новичок", "средний");
  const fullToAverage = ratio("полный арсенал", "средний");
  const lightToStandard = ratio("средний, слабое устройство", "средний");
  const median = (values: number[]): number => quantile([...values].sort((a, b) => a - b), 0.5);
  const levelOf = (runs: BalanceRunResult[]): number => median(runs.map((run) => run.startPressure));

  lines.push("", "### Вердикты по коридорам", "");
  lines.push(verdict(`новичок к среднему ${targets.noviceToAverage.min}–${targets.noviceToAverage.max}`, between(noviceToAverage, targets.noviceToAverage), noviceToAverage.toFixed(2)));
  lines.push(verdict(`полный к среднему ${targets.fullToAverage.min}–${targets.fullToAverage.max}`, between(fullToAverage, targets.fullToAverage), fullToAverage.toFixed(2)));
  lines.push(
    verdict(
      "порядок: новичок < средний < полный — с подстройкой и без",
      (medians["новичок"] ?? 0) < (medians["средний"] ?? 0) &&
        (medians["средний"] ?? 0) < (medians["полный арсенал"] ?? 0) &&
        (medians["новичок, без подстройки"] ?? 0) < (medians["средний, без подстройки"] ?? 0) &&
        (medians["средний, без подстройки"] ?? 0) < (medians["полный арсенал, без подстройки"] ?? 0),
      "по таблице",
    ),
  );
  // «Не больше половины преимущества» защищает сильного (Р183), поэтому только пара «средний → полный»:
  // новичку вниз работают все рычаги, и его отношение к среднему задаёт коридор лесенки.
  const withPressure = ratio("полный арсенал", "средний");
  const without = ratio("полный арсенал, без подстройки", "средний, без подстройки");
  lines.push(
    verdict(
      "средний → полный арсенал: с подстройкой не меньше √(без неё)",
      withPressure >= Math.sqrt(without),
      `с подстройкой ${withPressure.toFixed(2)}, без неё ${without.toFixed(2)}, √ = ${Math.sqrt(without).toFixed(2)}`,
    ),
  );
  lines.push(verdict(`слабое устройство к обычному ${targets.lightToStandard.min}–${targets.lightToStandard.max}`, between(lightToStandard, targets.lightToStandard), lightToStandard.toFixed(2)));

  const cap = PRESSURE.devices.caps.light;
  const lightPeakMax = Math.max(...results.averageLight.map((run) => run.peakEnemies));
  const standardPeak = median(results.averageOn.map((run) => run.peakEnemies));
  const lightPeak = median(results.averageLight.map((run) => run.peakEnemies));
  // Потолок держит поток, а не события: кольцо и строй стражей его не режут (Р67), поэтому к потолку
  // добавляется самое крупное событие таймлайна и запас на распад делящихся.
  const peakLimit = cap + largestEventSize() + targets.lightPeakSlack;
  lines.push(verdict(`пик на слабом не больше caps.light + крупнейшее событие + ${targets.lightPeakSlack} = ${peakLimit}`, lightPeakMax <= peakLimit, `макс ${lightPeakMax}`));
  lines.push(
    verdict(
      `пик на слабом не больше ${targets.lightPeakShareMax} от обычного, если обычный не ниже ${targets.lightPeakThreshold} × caps.light`,
      standardPeak < targets.lightPeakThreshold * cap || lightPeak <= targets.lightPeakShareMax * standardPeak,
      `слабое ${lightPeak}, обычное ${standardPeak}`,
    ),
  );
  for (const [id, runs] of [["novice", results.noviceOn], ["average", results.averageOn], ["full", results.fullOn]] as const) {
    const range = targets.levels[id];
    const value = levelOf(runs);
    lines.push(verdict(`L(${id}) в ${range.min}–${range.max}`, value >= range.min && value <= range.max, value.toFixed(2)));
  }

  lines.push(
    "",
    `Отношения соседних профилей (сильный / слабый), без подстройки → с подстройкой: ` +
      `новичок → средний ${ratio("средний, без подстройки", "новичок, без подстройки").toFixed(2)} → ${ratio("средний", "новичок").toFixed(2)}, ` +
      `средний → полный ${ratio("полный арсенал, без подстройки", "средний, без подстройки").toFixed(2)} → ${ratio("полный арсенал", "средний").toFixed(2)}.`,
    "",
    "Медиана бота на этих профилях двугорбая: забег либо обрывается на стене первых двух минут, либо живёт 600–1 100 с, " +
      "поэтому на пяти seed вердикты «новичок к среднему», «порядок» и «слабое устройство» ловят удачу, а не баланс. " +
      "Читать их надо по этой таблице на пятнадцати seed, в гейт они не входят.",
  );
  return lines;
}

/**
 * Расписание сборки (T-0196, решение 3.1): бессмертный бот профиля «средний»
 * без подстройки идёт до 1200 с, по минутам запоминается доля собранного
 * набора. Медиана по seed на сетке секунд, округление до 0,05, расписание не
 * убывает — готовый литерал для `PRESSURE.power.buildSchedule`.
 */
function scheduleLines(): string[] {
  const weapons = startingWeapons();
  const { average } = POWER_PROFILES;
  const byMinute: number[][] = [];
  for (const startingWeaponId of weapons) {
    for (let seed = 1; seed <= SCHEDULE_SEEDS; seed++) {
      const run = simulateBalanceRun({
        seed,
        skill: "dodging",
        startingWeaponId,
        difficultyId: BASE_DIFFICULTY_ID,
        godMode: true,
        maxSec: SCHEDULE_GRID_SEC[SCHEDULE_GRID_SEC.length - 1],
        loadout: average.loadout,
        pressure: false,
      });
      run.buildScoreByMinute.forEach((score, minute) => {
        (byMinute[minute] ??= []).push(score);
      });
    }
  }

  // Начало забега: набор ещё не растёт, остаётся доля стартового оружия.
  const start = createRunWorld({ seed: 1, mapId: "frontier", difficultyId: BASE_DIFFICULTY_ID, unitScale: 1, loadout: average.loadout }).world;
  const points: [number, number][] = [];
  let previous = 0;
  for (const sec of SCHEDULE_GRID_SEC) {
    const value = sec === 0 ? buildScoreOf(start) : quantile([...(byMinute[sec / 60 - 1] ?? [])].sort((a, b) => a - b), 0.5);
    const rounded = Math.max(previous, Math.round(value / 0.05) * 0.05);
    previous = rounded;
    points.push([sec, Number(rounded.toFixed(2))]);
  }

  return [
    "## Расписание сборки",
    "",
    `Бессмертный уклоняющийся бот, «${BASE_DIFFICULTY_ID}», профиль «${average.titleRu}», подстройка выключена, ${SCHEDULE_SEEDS} seed × ${weapons.length} оружия, до ${SCHEDULE_GRID_SEC[SCHEDULE_GRID_SEC.length - 1]} с. ` +
      "Медиана доли набора на сетке, округление до 0,05.",
    "",
    "| сек | " + points.map(([sec]) => String(sec)).join(" | ") + " |",
    "|---|" + points.map(() => "---").join("|") + "|",
    "| доля набора | " + points.map(([, value]) => value.toFixed(2)).join(" | ") + " |",
    "",
    `buildSchedule: [${points.map(([sec, value]) => `[${sec}, ${value}]`).join(", ")}]`,
  ];
}

/**
 * Кривая, которую проходит игрок уровнями (docs/35-stage4-plan.md §3.13, Р40):
 * первый уровень, середина таблицы разблокировок и всё открытое — на каждой
 * сложности. Баланс забега одинаков для всех, растёт только то, из чего
 * выбирать: разница строк — это и есть сила, которую даёт уровень. Бот
 * уклоняющийся, оружие — первое открытое.
 */
function levelLines(): string[] {
  const last = Math.max(...ACCOUNT_UNLOCKS.map((row) => row.level));
  const stages: { label: string; accountLevel: number | undefined }[] = [
    { label: "1-й уровень", accountLevel: 1 },
    { label: `${Math.ceil(last / 2)}-й уровень`, accountLevel: Math.ceil(last / 2) },
    { label: "всё открыто", accountLevel: undefined },
  ];
  const lines = ["## По уровню аккаунта", "", "| Уровень / сложность | медиана, с | p10 | p90 | до минуты | уровень забега |", "|---|---|---|---|---|---|"];
  for (const difficulty of DIFFICULTIES) {
    for (const stage of stages) {
      const runs: BalanceRunResult[] = [];
      for (let seed = 1; seed <= SEEDS; seed++) {
        runs.push(simulateBalanceRun({ skill: "dodging", difficultyId: difficulty.id, seed, ...(stage.accountLevel === undefined ? {} : { accountLevel: stage.accountLevel }) }));
      }
      const summary = summarizeRuns(runs);
      lines.push(
        `| ${stage.label} / ${difficulty.id} | ${fixed(summary.medianSurvivalSec)} | ${fixed(summary.p10SurvivalSec)} | ` +
          `${fixed(summary.p90SurvivalSec)} | ${percent(summary.deathsBeforeMinuteRatio)} | ${summary.medianLevel} |`,
      );
    }
  }
  return lines;
}

/**
 * Модификаторы забега: уклоняющийся бот на «Сложной», стартовые оружия первого уровня
 * аккаунта, те же seed. Коридор — отношение медианы к медиане без модификатора
 * (`MODIFIER_TARGETS`); вне коридора правятся множители `RUN_MODIFIERS`, а не коридор.
 * Бот двугорбый (гибнет на стене около 100-й секунды или живёт 10+ минут), поэтому рядом
 * с медианой стоят p10 и p90 и доля забегов, пережитых 5 минут.
 */
function modifierLines(): string[] {
  const firstLevel = unlocksAt(ACCOUNT_UNLOCKS, 1).weapons;
  const starting = BASE_WEAPONS.filter((weapon) => firstLevel.has(weapon.id)).map((weapon) => weapon.id);
  const runsOf = (modifierIds: string[]): BalanceRunResult[] => {
    const runs: BalanceRunResult[] = [];
    for (const startingWeaponId of starting) {
      for (let seed = 1; seed <= SEEDS; seed++) {
        runs.push(simulateBalanceRun({ seed, skill: "dodging", startingWeaponId, difficultyId: BASE_DIFFICULTY_ID, modifierIds }));
      }
    }
    return runs;
  };

  const baseline = summarizeRuns(runsOf([]));
  const lines = [
    "## Модификаторы забега (Р105)",
    "",
    `Уклоняющийся бот, «${BASE_DIFFICULTY_ID}», оружие первого уровня (${starting.join(", ")}), ${SEEDS} seed на оружие.`,
    "",
    "| Модификатор | медиана, с | p10 | p90 | до минуты | уровень | во сколько раз к «без модификатора» | коридор |",
    "|---|---|---|---|---|---|---|---|",
    `| без модификатора | ${fixed(baseline.medianSurvivalSec)} | ${fixed(baseline.p10SurvivalSec)} | ${fixed(baseline.p90SurvivalSec)} | ` +
      `${percent(baseline.deathsBeforeMinuteRatio)} | ${baseline.medianLevel} | ×1.00 | — |`,
  ];
  const verdicts: string[] = [];
  for (const modifier of RUN_MODIFIERS) {
    const summary = summarizeRuns(runsOf([modifier.id]));
    const ratio = summary.medianSurvivalSec / baseline.medianSurvivalSec;
    const range = MODIFIER_TARGETS.modifierMedianRatio[modifier.id];
    lines.push(
      `| ${modifier.id} | ${fixed(summary.medianSurvivalSec)} | ${fixed(summary.p10SurvivalSec)} | ${fixed(summary.p90SurvivalSec)} | ` +
        `${percent(summary.deathsBeforeMinuteRatio)} | ${summary.medianLevel} | ×${ratio.toFixed(2)} | ×${range.min}–×${range.max} |`,
    );
    verdicts.push(verdict(`${modifier.id}: медиана к «без модификатора» в ×${range.min}–×${range.max}`, ratio >= range.min && ratio <= range.max, `×${ratio.toFixed(2)}`));
  }
  return [...lines, "", ...verdicts];
}

function isOtherDifficulty(name: string): boolean {
  return DIFFICULTIES.some((difficulty) => difficulty.id !== BASE_DIFFICULTY_ID && name.endsWith(` / ${difficulty.id}`));
}

function verdict(what: string, ok: boolean, actual: string): string {
  return `- ${ok ? "в коридоре" : "ВНЕ КОРИДОРА"}: ${what} — ${actual}`;
}

function fixed(value: number): string {
  return value.toFixed(1);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
