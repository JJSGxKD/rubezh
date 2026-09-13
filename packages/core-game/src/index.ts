import type { RunEngine } from "./run-api";
import type { BenchStand, BenchStandOptions } from "./engine/bench-stand";

/**
 * Публичная поверхность движка.
 *
 * **Phaser здесь не импортируется.** Оболочка приложения тянет этот модуль
 * ради контента, типов и контракта забега; движок приходит отдельным чанком и
 * только когда игрок нажал «Играть» (docs/27-design-system-and-app-shell.md
 * §2 и §3.4). Статический импорт Phaser в этом файле утащил бы полтора
 * мегабайта в первую загрузку — и это проверяется бюджетом бандла в CI.
 */

export * from "./content/enemies";
export * from "./content/waves";
export * from "./content/maps";
export * from "./content/hash";
export * from "./content/upgrades";
export * from "./content/weapons";
export * from "./content/balance-targets";
export * from "./game/bench";

// Контракт забега — только типы, без реализации.
export type {
  HudSnapshot,
  RadarBlipKind,
  RadarSnapshot,
  RunDiagnosticsOptions,
  RunEngine,
  RunEvents,
  RunOptions,
  RunPauseReason,
  RunSession,
  RunSlotState,
} from "./run-api";

// Прокачка внутри забега: оболочка показывает варианты и возвращает выбор
// игрока (docs/27-design-system-and-app-shell.md §3.1).
export { xpForLevel, OFFERS_PER_LEVEL } from "./game/progression/levels";

// Итог забега: движок считает, оболочка показывает, хранит рекорд и отправляет
// (docs/26-stage2-plan.md, WP3).
export { loadBestSurvivalSec, submitRunResult, type RecordUpdate } from "./game/run/records";

export type { BenchStand, BenchStandOptions } from "./engine/bench-stand";

/**
 * Загрузить движок забега. Внутри — динамический импорт: Phaser и симуляция
 * уезжают в отдельный чанк, который не входит в первую загрузку.
 */
export async function loadRunEngine(): Promise<RunEngine> {
  const { createRunEngine } = await import("./engine/run-engine");
  return createRunEngine();
}

/**
 * Загрузить стенд FPS-испытаний. Отдельный чанк и отдельная дверь: игрокам он
 * не нужен вовсе (docs/25-week1-fps-trials.md §2).
 */
export async function loadBenchStand(options: BenchStandOptions): Promise<BenchStand> {
  const { createBenchStand } = await import("./engine/bench-stand");
  return createBenchStand(options);
}
