import {
  createGame,
  BENCH_DEFAULT_DURATION_SEC,
  BENCH_DEFAULT_RAMP_CAP,
  type BenchDevice,
  type BenchMode,
} from "@bh/core-game";
import { describeTelegramClient, TelegramAdapter } from "@bh/adapter-telegram";

const params = new URLSearchParams(globalThis.location.search);

// Стенд испытаний включается флагом сборки, а не режимом dev: мерить
// производительность нужно именно на прод-сборке — dev-сборка Phaser,
// sourcemap и клиент HMR занижают FPS (docs/25-week1-fps-trials.md §2).
// В сборке для игроков переменная пустая, ветка вырезается минификатором, и
// параметр ?bench в адресной строке ничего не открывает.
const benchAllowed = import.meta.env.VITE_BENCH_ENABLED === "1";

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
  if (raw === null || raw === "") return null;
  if (raw === "ramp") {
    return { mode: "ramp", population: numberParam("cap", BENCH_DEFAULT_RAMP_CAP) };
  }
  // Параметры агрессивного режима не настраиваются из адресной строки: их
  // смысл в том, чтобы прогоны на разных устройствах были сравнимы.
  if (raw === "stress") return { mode: "stress", population: BENCH_DEFAULT_RAMP_CAP };

  const population = Number(raw);
  if (!Number.isFinite(population) || population <= 0) return null;
  return { mode: "fixed", population };
}

function numberParam(name: string, fallback: number): number {
  const value = Number(params.get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Приёмник отчётов. Токен лежит в клиентском бандле и потому секретом не
 * является — он отсекает случайных сканеров, а не злоумышленника
 * (docs/20-env-and-ports.md §1, правило 6). Настоящая защита приёмника —
 * то, что он поднимается только на время испытаний.
 */
function readIngest(): { url: string; token: string } | null {
  const url = import.meta.env.VITE_BENCH_INGEST_URL ?? "";
  const token = import.meta.env.VITE_BENCH_INGEST_TOKEN ?? "";
  return url === "" || token === "" ? null : { url, token };
}

const bench = benchAllowed ? readBenchMode(params.get("bench")) : null;

// ?fps=60 — зафиксировать частоту отрисовки, чтобы прогоны на 60- и
// 120-герцовых экранах были сопоставимы (docs/25-week1-fps-trials.md §1.6).
const renderCapFps = params.has("fps") ? numberParam("fps", 60) : undefined;

// ?diag=1 — режим диагностики: на экране смерти видны seed и runId, а итог
// забега печатается в консоль. Временный переключатель: постоянный живёт в
// настройках оболочки, «Для тестировщиков» (docs/28-diagnostics.md §2, WP6).
const diagnostics = params.get("diag") === "1";

createGame(new TelegramAdapter(), {
  parent: "game",
  seed: numberParam("seed", 1),
  renderCapFps,
  diagnostics,
  // Отправку итога забега возьмёт на себя оболочка (WP5, WP8); до тех пор он
  // хотя бы виден в консоли устройства, с которого снимают баг-репорт.
  ...(diagnostics ? { onRunEnd: (result) => console.log("Итог забега:", result) } : {}),
  bench:
    bench === null
      ? undefined
      : {
          mode: bench.mode,
          population: bench.population,
          addPerSecond: numberParam("ramp", 2),
          durationSec: numberParam("duration", BENCH_DEFAULT_DURATION_SEC),
          buildVersion: import.meta.env.VITE_APP_VERSION ?? "dev",
          device: collectDevice(),
          ingest: readIngest(),
        },
});
