import {
  BENCH_DEFAULT_DURATION_SEC,
  BENCH_DEFAULT_RAMP_CAP,
  loadBenchStand,
  type BenchDevice,
  type BenchMode,
} from "@bh/core-game";
import { describeTelegramClient } from "@bh/adapter-telegram";

/**
 * Стенд FPS-испытаний (docs/25-week1-fps-trials.md). Вынесен из точки входа:
 * он включается флагом сборки и параметром адреса, а игрокам не показывается
 * вовсе — и не должен мешать читать запуск оболочки.
 */
export async function startBench(container: HTMLElement, params: URLSearchParams): Promise<void> {
  const mode = readBenchMode(params.get("bench"));
  if (mode === null) return;

  await loadBenchStand({
    container,
    mode: mode.mode,
    population: mode.population,
    addPerSecond: numberParam(params, "ramp", 2),
    seed: numberParam(params, "seed", 1),
    durationSec: numberParam(params, "duration", BENCH_DEFAULT_DURATION_SEC),
    buildVersion: import.meta.env.VITE_APP_VERSION ?? "dev",
    device: collectDevice(),
    ingest: readIngest(),
    // ?fps=60 — зафиксировать частоту отрисовки, чтобы прогоны на 60- и
    // 120-герцовых экранах были сопоставимы (docs/25-week1-fps-trials.md §1.6).
    ...(params.has("fps") ? { renderCapFps: numberParam(params, "fps", 60) } : {}),
  });
}

function collectDevice(): BenchDevice {
  const telegram = describeTelegramClient();
  // deviceMemory есть не везде (в Safari его нет вовсе) — читаем аккуратно
  // и не притворяемся, что знаем объём памяти, когда браузер молчит.
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;

  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
    deviceMemoryGb: typeof deviceMemory === "number" ? deviceMemory : null,
    screenWidth: screen.width,
    screenHeight: screen.height,
    devicePixelRatio: globalThis.devicePixelRatio ?? 1,
    telegramPlatform: telegram.platform,
    telegramVersion: telegram.version,
    telegramUserId: telegram.userId,
    telegramLanguage: telegram.languageCode,
    telegramIsPremium: telegram.isPremium,
    telegramFullscreen: telegram.isFullscreen,
  };
}

/**
 * `?bench=ramp` — нарастающая нагрузка (режим по умолчанию),
 * `?bench=stress` — агрессивный прогон до предела с остановкой по просадке,
 * `?bench=100` — фиксированная популяция.
 */
function readBenchMode(raw: string | null): { mode: BenchMode; population: number } | null {
  if (raw === null || raw === "" || raw === "ramp") {
    return { mode: "ramp", population: BENCH_DEFAULT_RAMP_CAP };
  }
  // Параметры агрессивного режима не настраиваются из адресной строки: их
  // смысл в том, чтобы прогоны на разных устройствах были сравнимы.
  if (raw === "stress") return { mode: "stress", population: BENCH_DEFAULT_RAMP_CAP };

  const population = Number(raw);
  if (!Number.isFinite(population) || population <= 0) return null;
  return { mode: "fixed", population };
}

/**
 * Приёмник отчётов. Токен лежит в клиентском бандле и потому секретом не
 * является — он отсекает случайных сканеров, а не злоумышленника
 * (docs/20-env-and-ports.md §1, правило 6).
 */
function readIngest(): { url: string; token: string } | null {
  const url = import.meta.env.VITE_BENCH_INGEST_URL ?? "";
  const token = import.meta.env.VITE_BENCH_INGEST_TOKEN ?? "";
  return url === "" || token === "" ? null : { url, token };
}

function numberParam(params: URLSearchParams, name: string, fallback: number): number {
  const value = Number(params.get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
