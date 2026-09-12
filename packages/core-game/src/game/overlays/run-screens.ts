import type { RunResult, UpgradeOption } from "@bh/shared-types";
import type { RecordUpdate } from "../run/records";

/**
 * Тексты временных экранов забега. Отдельно от сцены и от Phaser: так их
 * проверяет обычный тест, а сцена занимается циклом и вводом.
 *
 * Тексты здесь русские строки, а не ключи i18n, — сознательно и временно.
 * Экраны переедут в React-оболочку вместе со словарём (WP5,
 * docs/27-design-system-and-app-shell.md §8), а плодить ключи под выброшенную
 * разметку смысла нет. По той же причине оружие и враги показаны id, а не
 * названиями: переводов ещё нет.
 */

const OUTCOME_TITLES = {
  died: "ЗАБЕГ ОКОНЧЕН",
  abandoned: "ЗАБЕГ СДАН",
} as const;

/** Время выживания — главный показатель забега (Р2), поэтому первой строкой. */
export function formatDuration(totalSec: number): string {
  const safe = Number.isFinite(totalSec) && totalSec > 0 ? Math.floor(totalSec) : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export interface DeathScreenOptions {
  result: RunResult;
  record: RecordUpdate;
  /** в режиме диагностики видны seed и runId — с ними баг воспроизводим */
  diagnostics: boolean;
  /** ответ на нажатие кнопки-заглушки; пусто — ничего не нажимали */
  note: string;
}

export function deathScreenLines(options: DeathScreenOptions): string[] {
  const { result, record } = options;
  const lines = [
    OUTCOME_TITLES[result.outcome],
    `Время выживания: ${formatDuration(result.survivalSec)}`,
    record.isNewRecord
      ? "НОВЫЙ РЕКОРД"
      : `Лучший результат: ${formatDuration(record.bestSurvivalSec)}`,
    "",
    `Уровень ${result.level}, опыт ${Math.round(result.xpCollected)}`,
    `Убито врагов: ${result.enemiesKilled}${killsSuffix(result)}`,
    `Получено урона: ${Math.round(result.damageTaken)}${deathCauseSuffix(result)}`,
    `Пройдено: ${Math.round(result.distance)} | пик врагов: ${result.peakEnemies}`,
    "",
    "Урон по оружиям:",
    ...weaponLines(result),
  ];

  if (result.passives.length > 0) {
    lines.push(`Пассивки: ${result.passives.map((p) => `${p.id} ур.${p.level}`).join(", ")}`);
  }
  if (options.diagnostics) {
    lines.push("", `seed ${result.seed} | runId ${result.runId}`);
  }
  if (options.note !== "") lines.push("", options.note);

  return lines;
}

export function pauseScreenLines(elapsedSec: number, note: string): string[] {
  const lines = ["ПАУЗА", `Время выживания: ${formatDuration(elapsedSec)}`];
  if (note !== "") lines.push("", note);
  return lines;
}

export function surrenderScreenLines(elapsedSec: number): string[] {
  return [
    "СДАТЬСЯ?",
    `Забег идёт ${formatDuration(elapsedSec)} — он закончится, результат сохранится.`,
  ];
}

export function choiceScreenLines(level: number, queued: number): string[] {
  const lines = [`УРОВЕНЬ ${level}`, "Выбери улучшение:"];
  // Счётчик ожидающих уровней: иначе три экрана подряд выглядят как залипший
  // интерфейс (docs/27-design-system-and-app-shell.md §6).
  if (queued > 0) lines.push(`Ещё уровней в очереди: ${queued}`);
  return lines;
}

/** Подпись варианта улучшения на кнопке. */
export function offerLabel(offer: UpgradeOption): string {
  if (offer.kind === "heal") return "Лечение";
  return `${offer.refId} ур.${offer.level}`;
}

function weaponLines(result: RunResult): string[] {
  if (result.weapons.length === 0) return ["  оружия не было"];

  // По убыванию урона: геймдизайнеру нужно видеть, что тянет забег, а что
  // лежит мёртвым грузом, — порядок подбора для этого бесполезен.
  return [...result.weapons]
    .sort((a, b) => b.damage - a.damage)
    .map((weapon) => `  ${weapon.id} ур.${weapon.level} — ${Math.round(weapon.damage)}`);
}

function killsSuffix(result: RunResult): string {
  const top = Object.entries(result.killsByEnemy)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, count]) => `${id} ${count}`);
  return top.length === 0 ? "" : ` (${top.join(", ")})`;
}

function deathCauseSuffix(result: RunResult): string {
  return result.deathCause === null ? "" : ` | добил: ${result.deathCause}`;
}
