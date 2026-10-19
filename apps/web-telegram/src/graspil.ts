import { loadTelegramWebAppCompat, type TelegramWebAppCompat } from "@bh/adapter-telegram";

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
 * первый экран. Не загрузился — игра этого не замечает. Прослойка — тоже
 * после оболочки, из чанка рекламы.
 */

/** Имя очереди — как в сниппете Graspil: по нему скрипт находит свой ключ. */
const DATA_LAYER = "graspil";
/**
 * Имя очереди скрипт узнаёт из параметра `l` своего адреса, как в сниппете
 * кабинета. Без него он ключа не находит, и сервер Graspil отвечает 401.
 */
export const GRASPIL_SCRIPT = `https://w.graspil.com?l=${DATA_LAYER}`;

/** Адрес API — тот же, что у клиента в `main.tsx`: на dev-сервере свой origin, в сборке `VITE_API_URL`. */
const API_BASE = import.meta.env.DEV ? "" : (import.meta.env.VITE_API_URL ?? "");
const SCRIPTS_TIMEOUT_MS = 5_000;

/** Грузить ли Graspil по ответу сервера: только явное «да»; сбой, не тот ответ — нет. */
export function graspilAllowed(body: unknown): boolean {
  if (typeof body !== "object" || body === null || !("data" in body)) return false;
  const { data } = body;
  return typeof data === "object" && data !== null && "graspil" in data && data.graspil === true;
}

/** Спросить сервер, можно ли грузить Graspil (выключатель в панели). Нет ответа — нельзя. */
async function allowedByServer(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/v1/client/scripts`, { signal: AbortSignal.timeout(SCRIPTS_TIMEOUT_MS) });
    return response.ok && graspilAllowed(await response.json());
  } catch {
    // Таймаут и обрыв — тот же ответ «нельзя».
    return false;
  }
}

export async function loadGraspil(key: string): Promise<void> {
  if (key === "") return;
  // Аналитика необязательна: выключатель в панели нужен как раз затем, чтобы не тянуть скрипт в сомнении.
  if (!(await allowedByServer())) {
    console.info("Graspil выключен в панели или сервер не ответил — не грузим");
    return;
  }
  let webApp: TelegramWebAppCompat | null = null;
  try {
    webApp = await loadTelegramWebAppCompat();
  } catch (error: unknown) {
    // Чанк не догрузился — Graspil возьмёт данные запуска сам, если сможет.
    console.warn("Прослойка Telegram.WebApp для Graspil не загрузилась:", error);
  }

  // Очередь — глобальная переменная с именем из сниппета: типа у неё нет,
  // поэтому читается и пишется через Reflect, без приведения window.
  const existing: unknown = Reflect.get(window, DATA_LAYER);
  const queue: unknown[] = Array.isArray(existing) ? existing : [];
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
  Reflect.set(window, DATA_LAYER, queue);

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
