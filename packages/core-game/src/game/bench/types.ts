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
}

/** То, что уходит на сервер и лежит в буфере обмена. */
export interface BenchSubmission {
  /** ключ идемпотентности прогона, см. createUuid */
  reportId: string;
  report: BenchReport;
  verdict: BenchVerdict;
}
