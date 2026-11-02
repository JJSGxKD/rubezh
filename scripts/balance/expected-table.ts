import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { DIFFICULTIES } from "../../packages/core-game/src/content/difficulty";
import { CONTENT_HASH } from "../../packages/core-game/src/content/hash";
import { ACCOUNT_UNLOCKS } from "../../packages/core-game/src/content/unlocks";
import { BASE_WEAPONS } from "../../packages/core-game/src/content/weapons";
import { unlocksAt } from "../../packages/core-game/src/game/progression/unlocks";
import {
  buildExpectedTable,
  EXPECTED_MINUTES,
  expectedBandLoadouts,
  findExpectedTableProblems,
  loadoutPower,
  simulateBalanceRun,
  type BalanceRunResult,
  type ExpectedTable,
} from "../../packages/core-game/src/game/balance";

/**
 * Таблица ожидаемого для очков эффективности: `pnpm balance:expected`
 * (tasks/T-0291, Р152, design/art/meta-v2.md §2.2).
 *
 * Пять полос силы × 20 минут: уклоняющийся бот на «Сложной» по тем же зёрнам
 * и стартовым оружиям, что у `balance:sim`, медианы по прогонам. Результат —
 * файл, который читает сервер (`backend/api/src/modules/rating/expected-runs.json`).
 *
 * Отдельно от `balance:sim` и в гейт не входит: прогон долгий (сотни забегов по
 * двадцать минут). Правка контента, сдвигающая баланс, пересобирает таблицу в
 * том же PR (docs/32-balance.md, «Ожидаемое для рейтинга»).
 */

const SEEDS = 20;
/** Как у основной калибровки — главный бой (Р126). */
const DIFFICULTY_ID: (typeof DIFFICULTIES)[number]["id"] = "hard";
/** Двадцатая минута закрывается на 1200-й секунде; минута запаса, чтобы бот успел её закрыть. */
const MAX_SEC = (EXPECTED_MINUTES + 1) * 60;

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const TABLE_PATH = join(ROOT, "backend", "api", "src", "modules", "rating", "expected-runs.json");
const REPORT_PATH = join(ROOT, "var", "balance", "expected-table.md");

/** Стартовые оружия первого уровня аккаунта: с ними приходит новичок (как в `balance:sim`). */
function startingWeapons(): string[] {
  const firstLevel = unlocksAt(ACCOUNT_UNLOCKS, 1).weapons;
  return BASE_WEAPONS.filter((weapon) => firstLevel.has(weapon.id)).map((weapon) => weapon.id);
}

/**
 * Файл читает человек в диффе PR, поэтому шапка и полосы — отступами, а строка
 * таблицы — одной строкой: сто строк по двенадцать строк каждая не прочесть.
 */
function serialize(table: ExpectedTable): string {
  const head = JSON.stringify({ version: table.version, contentHash: table.contentHash, generatedAt: table.generatedAt }, null, 2);
  const bands = table.bands.map((band) => `    ${JSON.stringify(band)}`).join(",\n");
  const rows = table.rows.map((row) => `    ${JSON.stringify(row)}`).join(",\n");
  return `${head.slice(0, -2)},\n  "bands": [\n${bands}\n  ],\n  "rows": [\n${rows}\n  ]\n}\n`;
}

it("таблица ожидаемого для рейтинга", { timeout: 3_600_000 }, () => {
  const weapons = startingWeapons();
  const bands = expectedBandLoadouts().map(({ id, loadout }) => {
    const runs: BalanceRunResult[] = [];
    for (const startingWeaponId of weapons) {
      for (let seed = 1; seed <= SEEDS; seed++) {
        runs.push(simulateBalanceRun({ seed, skill: "dodging", startingWeaponId, difficultyId: DIFFICULTY_ID, maxSec: MAX_SEC, loadout }));
      }
    }
    return { id, power: loadoutPower(loadout), runs };
  });

  const table = buildExpectedTable({ contentHash: CONTENT_HASH, generatedAt: new Date().toISOString(), bands });
  const problems = findExpectedTableProblems(table);
  if (problems.length > 0) throw new Error(`Таблица не прошла проверку:\n${problems.join("\n")}`);

  mkdirSync(dirname(TABLE_PATH), { recursive: true });
  writeFileSync(TABLE_PATH, serialize(table), "utf8");

  const report = reportLines(table, bands);
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${report.join("\n")}\n`, "utf8");
  console.log(report.join("\n"));
  console.log(`\nТаблица сохранена: ${TABLE_PATH}`);
});

/** Сводка для глаз: сколько прогонов дожило до минут-вех и что в строках этих минут. */
function reportLines(table: ExpectedTable, bands: { id: string; power: number; runs: BalanceRunResult[] }[]): string[] {
  const milestones = [1, 3, 5, 8, 10, 15, 20];
  const lines = [
    "# Таблица ожидаемого для рейтинга",
    "",
    `Отпечаток контента: ${table.contentHash}. «${DIFFICULTY_ID}», ${SEEDS} seed × ${startingWeapons().length} оружия на полосу. ` +
      `«Дожили» — сколько прогонов дошло до минуты, из них строится строка; тонкая выборка в хвосте — повод смотреть строку с подозрением.`,
    "",
    "| Полоса | сила | от | до | дожили до минуты " + milestones.join(" / ") + " |",
    "|---|---|---|---|---|",
  ];
  for (const band of table.bands) {
    const source = bands.find((candidate) => candidate.id === band.id);
    const reached = milestones.map((minute) => (source?.runs ?? []).filter((run) => run.killsByMinute.length >= minute).length);
    lines.push(`| ${band.id} | ${source?.power ?? "?"} | ${band.fromPower} | ${band.toPower ?? "—"} | ${reached.join(" / ")} |`);
  }
  for (const band of table.bands) {
    lines.push("", `## ${band.id}`, "", "| Минута | убийств/мин | охота/мин | жизнь элиты, с | жизнь босса, с | урон/мин | сборка |", "|---|---|---|---|---|---|---|");
    for (const row of table.rows.filter((candidate) => candidate.band === band.id && milestones.includes(candidate.minute))) {
      lines.push(
        `| ${row.minute} | ${row.killsPerMin} | ${row.huntPerMin} | ${row.huntKillSec.elite} | ${row.huntKillSec.boss} | ${row.damageTakenPerMin} | ${row.buildScore} |`,
      );
    }
  }
  return lines;
}
