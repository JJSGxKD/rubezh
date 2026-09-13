import type { DifficultyId, RunResult, UpgradeOption } from "@bh/shared-types";

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
  /** пройденное расстояние в игровых единицах — подсказки обучения гаснут, когда игрок пошёл */
  distance: number;
  /** точки радара вокруг игрока */
  radar: RadarSnapshot;
}

/**
 * Вид точки радара: 0 — враг, 1 — элита, 2 — аптечка. Числом, а не строкой:
 * точки лежат в типизированном массиве, и снимок не плодит объектов.
 */
export type RadarBlipKind = 0 | 1 | 2;

/**
 * Радар — что вокруг игрока в пределах кольца спавна, в том числе за краем
 * экрана. Координаты — доли радиуса радара от −1 до 1 относительно игрока;
 * дальние точки прижаты к краю, чтобы угроза оттуда не пропадала.
 */
export interface RadarSnapshot {
  /** тройки подряд: x, y, вид (`RadarBlipKind`) */
  blips: Float32Array;
  count: number;
}

export interface RunSlotState {
  id: string;
  level: number;
}

/**
 * Почему забег стоит: игрок нажал паузу, приложение ушло в фон или забег
 * только что продолжен из снимка и ждёт, пока игрок будет готов.
 */
export type RunPauseReason = "manual" | "app_inactive" | "restored";

/**
 * Версия формата снимка. Меняется при любой правке снимка или мира: старое
 * сохранение тогда не продолжается, а не продолжается криво.
 */
export const RUN_SNAPSHOT_FORMAT = 2;

/**
 * Снимок прерванного забега — по нему забег продолжается после сворачивания,
 * вылета или перезапуска. Для оболочки он непрозрачен: она хранит его и
 * отдаёт обратно, а сама читает только заголовок и `summary` — для карточки
 * «Продолжить» в лобби.
 *
 * Снимок годится только для того контента, на котором снят: `contentHash`
 * другой — продолжать нельзя, числа врагов и оружия уже другие.
 */
export interface RunSnapshot {
  format: number;
  contentHash: string;
  runId: string;
  seed: number;
  mapId: string;
  difficultyId: DifficultyId;
  startingWeaponId: string;
  summary: RunSnapshotSummary;
  /** состояние мира; формат знает только движок */
  world: unknown;
}

export interface RunSnapshotSummary {
  survivalSec: number;
  level: number;
  weapons: RunSlotState[];
  passives: RunSlotState[];
}

export interface RunOptions {
  /** куда встроить канву забега */
  container: HTMLElement;
  seed: number;
  /** на старте режим один — бесконечный (решение Р8) */
  mode: "endless";
  mapId: string;
  /** уровень сложности; неизвестный id — базовая сложность без поправок */
  difficultyId: DifficultyId;
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
  /**
   * Продолжить забег из снимка. `seed`, карта, сложность и оружие тогда
   * берутся из снимка, а забег стартует на паузе с причиной `restored`.
   */
  resume?: RunSnapshot;
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
  /**
   * Снять снимок для продолжения. `null`, если продолжать нечего: забег
   * кончился или сцена ещё не создана.
   */
  snapshot(): RunSnapshot | null;
  destroy(): void;
}

export interface RunEngine {
  start(options: RunOptions): RunSession;
}
