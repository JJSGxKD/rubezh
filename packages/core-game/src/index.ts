import type { RunEngine } from "./run-api";
import type { BenchStand, BenchStandOptions } from "./engine/bench-stand";
import type { StressEngine } from "./stress-api";

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
export * from "./content/difficulty";
export * from "./content/drops";
export * from "./game/bench";

// Как выглядит мир забега — без Phaser: гайдбук оболочки рисует врагов и
// подборы теми же формами и цветами, что и канва.
export {
  ENEMY_LOOKS,
  enemyColor,
  GEM_TIERS,
  PICKUP_LOOKS,
  WORLD_COLORS,
  type ShapeKind,
  type ShapeLook,
} from "./game/render/looks";
// Умолчания паттернов — гайдбук берёт из них то, что враг не задал сам.
export { PATTERN_DEFAULTS } from "./game/patterns/enemy-types";

// Контракт забега — только типы, без реализации.
export type {
  HudSnapshot,
  RadarBlipKind,
  RadarSnapshot,
  RunDevCheats,
  RunDevCommand,
  RunDevInfo,
  RunDevOptions,
  RunDevPickup,
  RunDevVisuals,
  RunDiagnosticsOptions,
  RunEngine,
  RunEvents,
  RunInspection,
  RunOptions,
  RunPassiveInspection,
  RunWeaponInspection,
  RunPauseReason,
  RunSession,
  RunSlotState,
  RunSnapshot,
  RunSnapshotSummary,
} from "./run-api";
// Версия формата снимка — оболочка сверяет сохранение до того, как предложить «Продолжить».
export { RADAR_BLIP, RUN_SNAPSHOT_FORMAT } from "./run-api";

// Прокачка внутри забега: оболочка показывает варианты и возвращает выбор
// игрока (docs/27-design-system-and-app-shell.md §3.1).
export { xpForLevel, OFFERS_PER_LEVEL } from "./game/progression/levels";

// Итог забега: движок считает, оболочка показывает, хранит рекорд и отправляет
// (docs/26-stage2-plan.md, WP3).
export {
  loadBestSurvivalSec,
  mergeBestSurvivalSec,
  submitRunResult,
  type RecordUpdate,
} from "./game/run/records";

export type { BenchStand, BenchStandOptions } from "./engine/bench-stand";
export type { StressEngine, StressEvents, StressOptions, StressSession } from "./stress-api";

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

/**
 * Загрузить стресс-тест оболочки. Отдельная дверь от забега: сцена стенда
 * игрокам без доступа не нужна (docs/28-diagnostics.md §2.3).
 */
export async function loadStressEngine(): Promise<StressEngine> {
  const { createStressEngine } = await import("./engine/stress-engine");
  return createStressEngine();
}
