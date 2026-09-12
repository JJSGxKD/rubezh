import type { KeyValueStorage, RunResult } from "@bh/shared-types";

/**
 * Локальный рекорд времени выживания (docs/26-stage2-plan.md, WP3).
 *
 * Хранится через порт `KeyValueStorage` от адаптера, а не прямым
 * `localStorage`: площадка может дать своё хранилище, и переезд не должен
 * трогать ни движок, ни оболочку (docs/27-design-system-and-app-shell.md §7).
 * На этапе 5 рекорд переезжает в стор `meta` оболочки — движок его читать
 * перестанет, а формат ключа останется тем же.
 *
 * Версия — в имени ключа, значение — одно число строкой. Zod-схемы здесь нет
 * сознательно: проверять скаляр `Number.isFinite` и границей дешевле и
 * честнее, чем тащить схему в бандл ради одного поля. Как только в хранилище
 * появится объект настроек, разбор станет схемой (`15-engineering-standards.md` §5).
 */
const BEST_KEY = "bh.meta.v1.bestSurvivalSec";

/**
 * Потолок правдоподобия. Забег длиннее суток означает не рекорд, а испорченное
 * или подкрученное значение: показывать его игроку как его собственный
 * результат — хуже, чем сбросить.
 */
const MAX_PLAUSIBLE_SEC = 24 * 60 * 60;

export interface RecordUpdate {
  /** лучшее время после забега — его и показывает экран смерти */
  bestSurvivalSec: number;
  isNewRecord: boolean;
}

/** Сохранённый рекорд; 0 — рекорда нет, значение битое или хранилища нет. */
export function loadBestSurvivalSec(storage: KeyValueStorage | undefined): number {
  if (storage === undefined) return 0;

  const raw = storage.get(BEST_KEY);
  if (raw === null) return 0;

  const value = Number(raw);
  // Данные из хранилища — граница системы: пустая строка, `NaN` из чужой
  // версии формата или отрицательное число не должны утечь в интерфейс.
  if (!Number.isFinite(value) || value < 0 || value > MAX_PLAUSIBLE_SEC) {
    storage.remove(BEST_KEY);
    return 0;
  }
  return value;
}

/**
 * Учесть забег в рекорде. Сдача засчитывается наравне со смертью: игрок эти
 * минуты действительно прожил, а наказывать за выход из забега нечем — забег
 * всё равно закончен.
 */
export function submitRunResult(
  storage: KeyValueStorage | undefined,
  result: RunResult,
): RecordUpdate {
  const previous = loadBestSurvivalSec(storage);
  const survived = Number.isFinite(result.survivalSec) ? result.survivalSec : 0;

  if (survived <= previous) return { bestSurvivalSec: previous, isNewRecord: false };

  storage?.set(BEST_KEY, String(survived));
  return { bestSurvivalSec: survived, isNewRecord: true };
}
