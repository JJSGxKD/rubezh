import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { BALANCE_TARGETS } from "../../packages/core-game/src/content/balance-targets";
import { WEAPONS } from "../../packages/core-game/src/content/weapons";
import {
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

interface Scenario {
  skill: BotSkill;
  startingWeaponId: string;
}

it("свод калибровки баланса", () => {
  const scenarios = buildScenarios();
  const rows: string[] = [];
  const byScenario = new Map<string, BalanceRunResult[]>();

  for (const scenario of scenarios) {
    const runs: BalanceRunResult[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      runs.push(simulateBalanceRun({ ...scenario, seed }));
    }
    byScenario.set(`${scenario.skill} / ${scenario.startingWeaponId}`, runs);
  }

  rows.push("# Свод калибровки баланса");
  rows.push("");
  rows.push(`Seed на сценарий: ${SEEDS}. Отпечаток контента — в итоге каждого забега.`);
  rows.push("");
  rows.push("| Сценарий | медиана, с | p10 | p90 | до минуты | уровень | волна | 1-й уровень, с |");
  rows.push("|---|---|---|---|---|---|---|---|");

  for (const [name, runs] of byScenario) {
    const summary = summarizeRuns(runs);
    rows.push(
      `| ${name} | ${fixed(summary.medianSurvivalSec)} | ${fixed(summary.p10SurvivalSec)} | ` +
        `${fixed(summary.p90SurvivalSec)} | ${percent(summary.deathsBeforeMinuteRatio)} | ` +
        `${summary.medianLevel} | ${summary.medianWave} | ${fixed(summary.medianFirstLevelUpSec)} |`,
    );
  }

  rows.push("");
  rows.push(...corridorLines(byScenario));

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${rows.join("\n")}\n`, "utf8");
  console.log(rows.join("\n"));
  console.log(`\nТаблица сохранена: ${REPORT_PATH}`);
});

function buildScenarios(): Scenario[] {
  const starting = WEAPONS.filter((weapon) => weapon.starting === true).map((weapon) => weapon.id);
  const scenarios: Scenario[] = [];

  // Пассивный прогоняется на одном оружии: он всё равно не стреляет осмысленно,
  // а отвечает на единственный вопрос — умирает ли игрок, который ничего не
  // делает.
  scenarios.push({ skill: "passive", startingWeaponId: starting[0] });
  for (const startingWeaponId of starting) {
    scenarios.push({ skill: "dodging", startingWeaponId });
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

  // Свод по всем сценариям прячет сильный перекос: одно удачное стартовое
  // оружие вытягивает медиану за два слабых. Разбор по сценариям — отдельно.
  lines.push("", "## Перекос по стартовым оружиям", "");
  for (const [name, runs] of byScenario) {
    if (name.startsWith("passive")) continue;
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

function verdict(what: string, ok: boolean, actual: string): string {
  return `- ${ok ? "в коридоре" : "ВНЕ КОРИДОРА"}: ${what} — ${actual}`;
}

function fixed(value: number): string {
  return value.toFixed(1);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
