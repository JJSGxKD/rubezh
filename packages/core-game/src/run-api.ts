import type { RunResult, UpgradeOption } from "@bh/shared-types";

/**
 * Публичный контракт забега: чем оболочка приложения управляет движком и что
 * получает обратно (docs/27-design-system-and-app-shell.md §3.1).
 *
 * Три свойства, ради которых он такой:
 *
 * - **команды и события, а не общее состояние.** Оболочка не читает мир
 *   напрямую и не держит на него ссылку — иначе React-компонент однажды
 *   подпишется на позицию врага и начнёт перерисовываться 60 раз в секунду;
 * - **выбор улучшения — команда**, которая применяется на границе тика и
 *   пишется в лог ввода: забег остаётся воспроизводимым;
 * - **движок не ходит в сеть.** Он отдаёт `RunResult`, отправкой занимается
 *   оболочка (docs/15-engineering-standards.md §2.2).
 *
 * Здесь только типы: файл не тянет ни Phaser, ни симуляцию, поэтому его
 * можно импортировать из оболочки, не утаскивая движок в основной бандл.
 */

/** Снимок состояния для HUD. Приходит не чаще 10 раз в секунду. */
export interface HudSnapshot {
  survivalSec: number;
  hp: number;
  maxHp: number;
  level: number;
  /** опыт на текущем уровне и порог следующего */
  xp: number;
  xpToNext: number;
  /** отрезок таймлайна спавна — «волна» в аналитике */
  wave: number;
  enemiesAlive: number;
  enemiesKilled: number;
  weapons: RunSlotState[];
  passives: RunSlotState[];
}

export interface RunSlotState {
  id: string;
  level: number;
}

export type RunPauseReason = "manual" | "app_inactive";

export interface RunOptions {
  /** куда встроить канву забега */
  container: HTMLElement;
  seed: number;
  /** на старте режим один — бесконечный (решение Р8) */
  mode: "endless";
  mapId: string;
  startingWeaponId: string;
  diagnostics: RunDiagnosticsOptions;
  /**
   * Физических пикселей на CSS-пиксель. Передаётся снаружи, а не читается из
   * `devicePixelRatio`: стенд испытаний фиксирует его, чтобы прогоны на
   * разных экранах были сравнимы.
   */
  pixelRatio?: number;
  /** ограничение частоты отрисовки — только для замеров */
  renderCapFps?: number;
}

export interface RunDiagnosticsOptions {
  /** запись забега для повтора (docs/28-diagnostics.md §3.4), WP7 */
  recordRun: boolean;
  /** оверлей FPS поверх забега */
  fpsOverlay: boolean;
}

export interface RunEvents {
  /** снимок для HUD, не чаще 10 Гц */
  hud: HudSnapshot;
  /** начался новый отрезок таймлайна спавна — `wave_reached` в аналитике */
  waveReached: { index: number; elapsedSec: number };
  /** набран уровень: мир стоит, пока оболочка не вернёт выбор */
  levelUp: { level: number; options: UpgradeOption[]; queued: number };
  paused: { reason: RunPauseReason; elapsedSec: number };
  resumed: { elapsedSec: number };
  /** забег кончился смертью */
  finished: RunResult;
  /** игрок сдался на экране паузы */
  abandoned: RunResult;
  error: { message: string };
}

export interface RunSession {
  on<E extends keyof RunEvents>(event: E, handler: (payload: RunEvents[E]) => void): () => void;
  chooseUpgrade(optionId: string): void;
  pause(reason: RunPauseReason): void;
  resume(): void;
  abandon(): void;
  /** начать заново в уже загруженном движке: от смерти до забега один тап */
  restart(seed: number): void;
  destroy(): void;
}

export interface RunEngine {
  start(options: RunOptions): RunSession;
}
