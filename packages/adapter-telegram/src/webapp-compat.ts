import { isTMA, retrieveLaunchParams, retrieveRawInitData } from "@tma.js/sdk";

/**
 * `window.Telegram.WebApp` для сторонних SDK — аналитики Graspil и ей
 * подобных (docs/22-analytics-and-metrics.md §9). Они написаны под
 * официальный `telegram-web-app.js` и читают данные запуска из этого
 * объекта, а у нас SDK `@tma.js/sdk`, и объекта нет.
 *
 * Прослойка собирает объект из тех же данных запуска, что читает адаптер, —
 * без второго SDK и без загрузки скрипта с telegram.org (подход из
 * `vpnsibcom_web/src/core/initTelegramWebAppCompat.ts`). Отличия от источника:
 * типы вместо `any` и `@ts-ignore`, и прослойка **только для чтения** —
 * кнопки, закрытие и полноэкранный режим остаются за адаптером: два SDK,
 * управляющие одной кнопкой, спорили бы о её состоянии.
 */

type Handler = () => void;

interface CompatButton {
  text: string;
  isVisible: boolean;
  show(): void;
  hide(): void;
  onClick(handler: Handler): void;
  offClick(handler: Handler): void;
}

export interface TelegramWebAppCompat {
  initData: string;
  initDataUnsafe: Record<string, unknown>;
  version: string;
  platform: string;
  colorScheme: "light" | "dark";
  themeParams: Record<string, unknown>;
  isActive: boolean;
  isExpanded: boolean;
  viewportHeight: number;
  viewportStableHeight: number;
  MainButton: CompatButton;
  SecondaryButton: CompatButton;
  BackButton: CompatButton;
  SettingsButton: CompatButton;
  isVersionAtLeast(version: string): boolean;
  onEvent(event: string, handler: Handler): void;
  offEvent(event: string, handler: Handler): void;
  ready(): void;
  expand(): void;
}

type TelegramWindow = Window & { Telegram?: { WebApp?: unknown } & Record<string, unknown> };

/**
 * Поставить `window.Telegram.WebApp`, если его нет. Вне клиента Telegram и
 * при битых параметрах запуска — ничего не делает: сторонний SDK тогда
 * просто не найдёт данных, а игра об этом и не узнает.
 */
export function installTelegramWebAppCompat(): TelegramWebAppCompat | null {
  if (typeof window === "undefined") return null;
  const target = window as TelegramWindow;
  if (target.Telegram?.WebApp !== undefined || !isTMA()) return null;

  let webApp: TelegramWebAppCompat;
  try {
    webApp = buildWebApp();
  } catch (error: unknown) {
    console.warn("Не удалось собрать Telegram.WebApp для сторонних SDK:", error);
    return null;
  }
  target.Telegram = { ...(target.Telegram ?? {}), WebApp: webApp };
  return webApp;
}

function buildWebApp(): TelegramWebAppCompat {
  const launch = retrieveLaunchParams();
  const version = launch.tgWebAppVersion ?? "6.0";
  const theme = (launch.tgWebAppThemeParams ?? {}) as Record<string, unknown>;
  const dark = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;

  return {
    initData: retrieveRawInitData() ?? "",
    initDataUnsafe: unsafeData(launch.tgWebAppData),
    version,
    platform: launch.tgWebAppPlatform ?? "unknown",
    colorScheme: dark ? "dark" : "light",
    themeParams: theme,
    isActive: true,
    isExpanded: true,
    viewportHeight: window.innerHeight,
    viewportStableHeight: window.innerHeight,
    MainButton: inertButton(),
    SecondaryButton: inertButton(),
    BackButton: inertButton(),
    SettingsButton: inertButton(),
    isVersionAtLeast: (wanted) => compareVersions(version, wanted) >= 0,
    // События площадки чужому SDK не транслируются: подписку на них мы в
    // Graspil выключаем (`trackTgEvents: false`), а ложных событий лучше не
    // слать вовсе.
    onEvent: () => undefined,
    offEvent: () => undefined,
    ready: () => undefined,
    expand: () => undefined,
  };
}

/**
 * Данные запуска в виде `initDataUnsafe`: поля SDK уже в snake_case, как у
 * `telegram-web-app.js`; дата — секундами, как в подписанной строке.
 */
function unsafeData(data: unknown): Record<string, unknown> {
  if (typeof data !== "object" || data === null) return {};
  const unsafe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    unsafe[key] = value instanceof Date ? Math.floor(value.getTime() / 1000) : value;
  }
  return unsafe;
}

function inertButton(): CompatButton {
  return {
    text: "",
    isVisible: false,
    show: () => undefined,
    hide: () => undefined,
    onClick: () => undefined,
    offClick: () => undefined,
  };
}

/** «8.0» против «7.10»: по частям числами, а не строкой. */
export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}
