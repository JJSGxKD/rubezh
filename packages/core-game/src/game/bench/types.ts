import type { BenchDevice, BenchLoadout, BenchMode, BenchReport } from "./metrics";
import type { BenchVerdict } from "./verdict";

/** Куда стенд отправляет готовый отчёт. null — отправка выключена. */
export interface BenchIngestConfig {
  url: string;
  token: string;
}

/**
 * Параметры стресс-прогона. Вынесены отдельно от сцены, чтобы точка входа
 * игры могла их типизировать, не втягивая саму сцену в основной бандл:
 * BenchScene грузится динамически и только когда стенд включён.
 */
export interface BenchSceneData {
  mode: BenchMode;
  /** для fixed — целевая популяция, для ramp — потолок роста */
  population: number;
  /** прирост популяции в секунду в режиме ramp */
  addPerSecond: number;
  seed: number;
  durationSec: number;
  buildVersion: string;
  /**
   * Сведения об устройстве собирает приложение платформы, а не движок:
   * core-game не знает, что такое Telegram (docs/01-tech-stack.md §1).
   */
  device: BenchDevice;
  ingest: BenchIngestConfig | null;
  /** по умолчанию `starting` — профиль стенда этапа 1 */
  loadout?: BenchLoadout;
  /**
   * `canvas` — стенд рисует свой текст и кнопки поверх канвы (`?bench=`);
   * `shell` — канва без интерфейса, прогресс и итог уходят в `listener`, а
   * показывает их оболочка (docs/28-diagnostics.md §2.3).
   */
  presentation?: "canvas" | "shell";
  listener?: BenchListener;
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

/** То, что уходит на сервер и лежит в буфере обмена. */
export interface BenchSubmission {
  /** ключ идемпотентности прогона, см. createUuid */
  reportId: string;
  report: BenchReport;
  verdict: BenchVerdict;
}
