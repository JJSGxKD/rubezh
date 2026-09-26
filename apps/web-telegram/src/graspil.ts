import { installTelegramWebAppCompat } from "@bh/adapter-telegram";

/**
 * Graspil — сторонняя аналитика Mini App (решение участника 1 от 26.09.2026,
 * docs/22-analytics-and-metrics.md §9).
 *
 * Тот же сниппет, что в кабинете Graspil, только модулем сборки: политика
 * источников не пускает встроенные скрипты (scripts/vite/content-security-policy.ts),
 * и сниппет в разметке просто не выполнился бы.
 *
 * Скрипт Graspil рассчитан на `window.Telegram.WebApp`, которого у нас нет,
 * поэтому перед ним ставится прослойка из адаптера, а сырые данные запуска
 * кладутся в очередь сразу (`custom_init_data_row`) — так Graspil не зависит
 * от прослойки там, где её данных ему не хватит (подход из
 * `vpnsibcom_web/src/app/_components/AnalyticsInit.tsx`).
 *
 * Скрипт грузится асинхронно и после оболочки: аналитика не задерживает
 * первый экран. Не загрузился — игра этого не замечает.
 */

const GRASPIL_SCRIPT = "https://w.graspil.com";
/** Имя очереди — как в сниппете Graspil: по нему скрипт находит свой ключ. */
const DATA_LAYER = "graspil";

type GraspilWindow = Window & Record<string, unknown>;

export function loadGraspil(key: string): void {
  if (key === "") return;
  const webApp = installTelegramWebAppCompat();

  const target = window as GraspilWindow;
  const queue = Array.isArray(target[DATA_LAYER]) ? (target[DATA_LAYER] as unknown[]) : [];
  // Клики — только по размеченным элементам, а не по каждому касанию канвы
  // забега; события площадки — выключены: прослойка их не транслирует.
  queue.push({ key, trackClicks: "tagged", trackTgEvents: false });
  if (webApp !== null) {
    queue.push({
      custom_init_data_row: webApp.initData,
      platform: webApp.platform,
      version: webApp.version,
      colorScheme: webApp.colorScheme,
      viewportHeight: webApp.viewportHeight,
      ...startParam(webApp.initDataUnsafe),
    });
  }
  target[DATA_LAYER] = queue;

  const script = document.createElement("script");
  script.async = true;
  script.src = GRASPIL_SCRIPT;
  // Аналитика необязательна: сбой — предупреждение в консоль для разбора, а
  // не ошибка игрока.
  script.onerror = () => console.warn(`Graspil не загрузился: ${GRASPIL_SCRIPT}`);
  document.head.appendChild(script);
}

function startParam(unsafe: Record<string, unknown>): { tgWebAppStartParam?: string } {
  const value = unsafe.start_param;
  return typeof value === "string" && value !== "" ? { tgWebAppStartParam: value } : {};
}
