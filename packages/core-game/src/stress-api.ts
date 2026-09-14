import type { BenchDevice, BenchMode } from "./game/bench/metrics";
import type { BenchProgress, BenchSubmission } from "./game/bench/types";

/**
 * Контракт стресс-теста в оболочке (docs/28-diagnostics.md §2.3): те же
 * принципы, что у забега (`run-api.ts`) — команды и события, движок не ходит
 * в сеть, здесь только типы.
 *
 * Прогон идёт на нагрузке позднего забега: всё оружие и пассивки на
 * максимуме, все паттерны врагов, элиты, кристаллы и подборы
 * (`game/bench/full-load.ts`). Автопилот и бессмертие — как у стенда этапа 1:
 * замер не должен зависеть от того, как человек играл.
 */

export interface StressOptions {
  container: HTMLElement;
  /**
   * `stress` — предел устройства, останавливается сам на подтверждённой
   * просадке; `ramp` — рабочий запас за три минуты; `fixed` — постоянная
   * толпа для сравнения сборок
   */
  mode: BenchMode;
  seed: number;
  buildVersion: string;
  /** сведения об устройстве собирает оболочка: движок не знает площадку */
  device: BenchDevice;
}

export interface StressEvents {
  progress: BenchProgress;
  /** отчёт и вердикт; отправляет оболочка */
  finished: BenchSubmission;
  error: { message: string };
}

export interface StressSession {
  on<E extends keyof StressEvents>(event: E, handler: (payload: StressEvents[E]) => void): () => void;
  /** остановить прогон досрочно — отчёт соберётся по снятым кадрам */
  stop(): void;
  destroy(): void;
}

export interface StressEngine {
  start(options: StressOptions): StressSession;
}
