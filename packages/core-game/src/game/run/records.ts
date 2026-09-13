import type { DifficultyId, KeyValueStorage, RunResult } from "@bh/shared-types";

/**
 * Локальный рекорд времени выживания (docs/26-stage2-plan.md, WP3) — по
 * каждому уровню сложности отдельно: десять минут на «Лёгкой» и на «Сложной»
 * несравнимы, и общий рекорд обесценил бы оба.
 *
 * Хранится через порт `KeyValueStorage` от адаптера, а не прямым
 * `localStorage`: площадка может дать своё хранилище, и переезд не должен
 * трогать ни движок, ни оболочку (docs/27-design-system-and-app-shell.md §7).
 *
 * Версия — в имени ключа, значение — одно число строкой. Zod-схемы здесь нет
 * сознательно: проверять скаляр `Number.isFinite` и границей дешевле и
 * честнее, чем тащить схему в бандл ради одного поля
 * (`15-engineering-standards.md` §5).
 */
const BEST_KEY_PREFIX = "bh.meta.v1.bestSurvivalSec";

/**
 * Рекорд до появления сложности. Он поставлен на нынешней «Лёгкой» — тот же
 * баланс без поправок, — и переезжает туда при первом чтении.
 */
const LEGACY_BEST_KEY = BEST_KEY_PREFIX;

/**
 * Потолок правдоподобия. Забег длиннее суток означает не рекорд, а испорченное
 * или подкрученное значение: показывать его игроку как его собственный
 * результат — хуже, чем сбросить.
 */
const MAX_PLAUSIBLE_SEC = 24 * 60 * 60;

export interface RecordUpdate {
  /** лучшее время на этой сложности после забега — его и показывает экран смерти */
  bestSurvivalSec: number;
  isNewRecord: boolean;
}

function bestKey(difficultyId: DifficultyId): string {
  return `${BEST_KEY_PREFIX}.${difficultyId}`;
}

/** Сохранённый рекорд на сложности; 0 — рекорда нет, значение битое или хранилища нет. */
export function loadBestSurvivalSec(
  storage: KeyValueStorage | undefined,
  difficultyId: DifficultyId,
): number {
  if (storage === undefined) return 0;
  if (difficultyId === "easy") migrateLegacyRecord(storage);
  return readRecord(storage, bestKey(difficultyId));
}

/**
 * Учесть забег в рекорде его сложности. Сдача засчитывается наравне со
 * смертью: игрок эти минуты действительно прожил, а наказывать за выход из
 * забега нечем — забег всё равно закончен.
 */
export function submitRunResult(
  storage: KeyValueStorage | undefined,
  result: RunResult,
): RecordUpdate {
  const previous = loadBestSurvivalSec(storage, result.difficultyId);
  const survived = Number.isFinite(result.survivalSec) ? result.survivalSec : 0;

  if (survived <= previous) return { bestSurvivalSec: previous, isNewRecord: false };

  storage?.set(bestKey(result.difficultyId), String(survived));
  return { bestSurvivalSec: survived, isNewRecord: true };
}

function readRecord(storage: KeyValueStorage, key: string): number {
  const raw = storage.get(key);
  if (raw === null) return 0;

  const value = Number(raw);
  // Данные из хранилища — граница системы: пустая строка, `NaN` из чужой
  // версии формата или отрицательное число не должны утечь в интерфейс.
  if (!Number.isFinite(value) || value < 0 || value > MAX_PLAUSIBLE_SEC) {
    storage.remove(key);
    return 0;
  }
  return value;
}

function migrateLegacyRecord(storage: KeyValueStorage): void {
  if (storage.get(LEGACY_BEST_KEY) === null) return;
  const legacy = readRecord(storage, LEGACY_BEST_KEY);
  storage.remove(LEGACY_BEST_KEY);
  if (legacy > readRecord(storage, bestKey("easy"))) storage.set(bestKey("easy"), String(legacy));
}
