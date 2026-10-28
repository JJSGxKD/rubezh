import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { BALANCE_TARGETS } from "../../packages/core-game/src/content/balance-targets";
import { DIFFICULTIES } from "../../packages/core-game/src/content/difficulty";
import { ENEMY_STAGES } from "../../packages/core-game/src/content/stages";
import { ENDLESS_CURVE } from "../../packages/core-game/src/content/waves";
import { ACCOUNT_UNLOCKS } from "../../packages/core-game/src/content/unlocks";
import { BASE_WEAPONS } from "../../packages/core-game/src/content/weapons";
import { unlocksAt } from "../../packages/core-game/src/game/progression/unlocks";
import {
  quantile,
  simulateBalanceRun,
  summarizeRuns,
  type BalanceRunResult,
  type BotSkill,
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

/** Обучающий первый забег: коридоры блока `tutorial`. */
const TUTORIAL_DIFFICULTY_ID: DifficultyId = "easy";

/** Зонд давления: seed на оружие, потолок прогона и ширина окна урона. */
const PRESSURE_SEEDS = 10;
const PRESSURE_MAX_SEC = 1020;
const PRESSURE_WINDOW_MIN = 3;

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
  rows.push(...levelLines());

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${rows.join("\n")}\n`, "utf8");
  console.log(rows.join("\n"));
  console.log(`\nТаблица сохранена: ${REPORT_PATH}`);
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

  lines.push("", "## Обучающая «Лёгкая»", "");
  const tutorial: BalanceRunResult[] = [];
  for (const [name, runs] of byScenario) {
    if (name.endsWith(` / ${TUTORIAL_DIFFICULTY_ID}`)) tutorial.push(...runs);
  }
  const tutorialSummary = summarizeRuns(tutorial);
  const tutorialTarget = target.tutorial;
  lines.push(
    verdict(
      `медиана уклоняющегося в ${tutorialTarget.dodgingMedianSec.min}–${tutorialTarget.dodgingMedianSec.max} с`,
      tutorialSummary.medianSurvivalSec >= tutorialTarget.dodgingMedianSec.min &&
        tutorialSummary.medianSurvivalSec <= tutorialTarget.dodgingMedianSec.max,
      `${fixed(tutorialSummary.medianSurvivalSec)} с`,
    ),
  );
  lines.push(
    verdict(
      `смертей до минуты не больше ${percent(tutorialTarget.dodgingDeathsBeforeMinuteRatioMax)}`,
      tutorialSummary.deathsBeforeMinuteRatio <= tutorialTarget.dodgingDeathsBeforeMinuteRatioMax,
      percent(tutorialSummary.deathsBeforeMinuteRatio),
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
