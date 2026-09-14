import { mountAppShell, type AnalyticsSink } from "@bh/app-shell";
import { CONTENT_HASH } from "@bh/core-game";
import { isTelegramEnvironment, TelegramAdapter } from "@bh/adapter-telegram";
import { startBench } from "./bench";

/**
 * Точка входа Telegram-сборки: собирает адаптер площадки и монтирует
 * оболочку. Больше здесь ничего нет — ни экранов, ни игры: за интерфейс
 * отвечает `app-shell`, за забег — `core-game`
 * (docs/27-design-system-and-app-shell.md §2).
 */
const params = new URLSearchParams(globalThis.location.search);
const container = document.getElementById("app");

if (container === null) {
  throw new Error("Нет контейнера #app в разметке");
}

// Стенд испытаний включается флагом сборки, а не режимом dev: мерить
// производительность нужно именно на прод-сборке — dev-сборка Phaser,
// sourcemap и клиент HMR занижают FPS (docs/25-week1-fps-trials.md §2).
// В сборке для игроков переменная пустая, ветка вырезается минификатором.
const benchAllowed = import.meta.env.VITE_BENCH_ENABLED === "1";

if (benchAllowed && params.get("bench") !== null) {
  void startBench(container, params);
} else {
  void mountAppShell({
    container,
    adapter: new TelegramAdapter(),
    build: {
      version: import.meta.env.VITE_APP_VERSION ?? "dev",
      contentHash: CONTENT_HASH,
      platform: "telegram",
    },
    capabilities: {
      // Проверка площадки — забота приложения: оболочка не знает, что бывает
      // «не Telegram», и потому одинаково работает на любой площадке.
      //
      // В dev-сборке экран «откройте в Telegram» пропускается: вся команда
      // правит интерфейс в обычном браузере, а возможности площадки в этот
      // момент отдаёт браузерная реализация адаптера. В прод-сборке ветка
      // вырезается минификатором.
      platformAvailable: isTelegramEnvironment() || import.meta.env.DEV,
      botUrl: botUrl(),
      // На время закрытого теста диагностика включена сразу: тестеру не нужно
      // лезть в настройки, чтобы в отчёте о баге оказался seed. Выключить её
      // он при этом может в любой момент.
      diagnosticsByDefault: import.meta.env.VITE_DIAGNOSTICS_DEFAULT === "1",
      // Сохранения и лидерборд плейтеста. Dev-сервер всегда ходит на свой же
      // домен — запросы проксирует Vite, в том числе через туннель
      // (vite.config.ts): адрес API из .env телефону через туннель недоступен.
      // Сборка берёт VITE_API_URL, пустой — тоже тот же домен.
      // Вход без Telegram — только из dev-сервера: в сборку имя не попадает.
      playtest: {
        baseUrl: import.meta.env.DEV ? "" : (import.meta.env.VITE_API_URL ?? ""),
        devUser: import.meta.env.DEV ? (import.meta.env.VITE_PLAYTEST_DEV_USER ?? "") : "",
      },
    },
    analytics: createAnalytics(),
  });
}

function botUrl(): string {
  const username = import.meta.env.VITE_TELEGRAM_BOT_USERNAME ?? "";
  return username === "" ? "" : `https://t.me/${username}`;
}

/**
 * Приёмник событий. Конвейер аналитики появится в WP8; до тех пор события
 * видно в консоли устройства, с которого снимают баг-репорт, — и только в
 * режиме диагностики, чтобы не засорять консоль игрокам.
 */
function createAnalytics(): AnalyticsSink {
  const verbose = import.meta.env.DEV || params.get("diag") === "1";
  if (!verbose) return () => undefined;

  return (event, payload) => console.log(`[событие] ${String(event)}`, payload);
}
