import type { BenchDevice, BenchReport } from "./metrics";
import type { BenchVerdict } from "./verdict";

/**
 * Параметры стресс-теста. Вынесены отдельно от сцены, чтобы точка входа
 * игры могла их типизировать, не втягивая саму сцену в основной бандл:
 * BenchScene грузится динамически и только когда тест запущен.
 */
export interface BenchSceneData {
  seed: number;
  buildVersion: string;
  /**
   * Сведения об устройстве собирает оболочка, а не движок: core-game не
   * знает, что такое Telegram (docs/01-tech-stack.md §1).
   */
  device: BenchDevice;
  /** прогресс и итог уходят в оболочку — она рисует интерфейс поверх канвы */
  listener: BenchListener;
}

/** Сводка прогона для интерфейса оболочки — несколько раз в секунду, не каждый кадр. */
export interface BenchProgress {
  elapsedSec: number;
  durationSec: number;
  running: boolean;
  enemies: number;
  projectiles: number;
  gems: number;
  /**
   * враги и снаряды — та же мера, что `peakObjects` в отчёте. Кристаллы идут
   * отдельно: их пул ограничен и сливается, осью нагрузки они не растут
   */
  objects: number;
  /** сколько врагов стенд хочет держать сейчас */
  targetEnemies: number;
  /** по последней корзине таймлайна; `null` — корзина ещё не набралась */
  fps: number | null;
  p95FrameMs: number | null;
  /** секунд просадки подряд — стенд вот-вот остановится */
  badWindows: number;
  interruptions: number;
}

export interface BenchListener {
  progress(progress: BenchProgress): void;
  finished(submission: BenchSubmission): void;
}

/** То, что уходит на сервер. */
export interface BenchSubmission {
  /** ключ идемпотентности прогона, см. createUuid */
  reportId: string;
  report: BenchReport;
  verdict: BenchVerdict;
}
