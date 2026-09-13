import type { KeyValueStorage, PlatformAdapter } from "@bh/shared-types";
import { create } from "zustand";
import { noopAnalytics, type AnalyticsEvent, type AnalyticsPayload, type AnalyticsSink } from "./analytics";

/**
 * Окружение оболочки: площадка, хранилище, аналитика и сведения о сборке.
 *
 * Адаптер приходит готовым объектом из `apps/web-*` и здесь только хранится:
 * оболочка не импортирует ни один `adapter-*`, иначе она становится
 * телеграм-оболочкой (docs/27-design-system-and-app-shell.md §2).
 */
export interface ShellBuildInfo {
  /** версия приложения из сборки */
  version: string;
  /** отпечаток игрового контента — разрез аналитики по версии баланса */
  contentHash: string;
  /** площадка сборки: telegram / max / vk / web */
  platform: string;
}

export interface ShellCapabilities {
  /**
   * Доступна ли площадка. Решает приложение: оболочка не знает, что бывает
   * «не Telegram» (docs/27-design-system-and-app-shell.md §2).
   */
  platformAvailable: boolean;
  /** куда отправить игрока, открывшего игру мимо мессенджера */
  botUrl: string;
  /**
   * Включать ли режим диагностики по умолчанию. На время закрытого теста —
   * да: тестеру не нужно лезть в настройки, чтобы в отчёте о баге оказался
   * seed. Переключатель при этом остаётся, выключить можно всегда.
   */
  diagnosticsByDefault: boolean;
}

export interface ShellState {
  adapter: PlatformAdapter;
  capabilities: ShellCapabilities;
  storage: KeyValueStorage | undefined;
  analytics: AnalyticsSink;
  build: ShellBuildInfo;
}

const PLACEHOLDER: ShellState = {
  // Заглушка до монтирования: сюда обращаются только компоненты, а они
  // появляются после `mountAppShell`. Пустой адаптер здесь честнее, чем
  // `null`, который пришлось бы проверять в каждом обращении.
  adapter: undefined as unknown as PlatformAdapter,
  capabilities: { platformAvailable: false, botUrl: "", diagnosticsByDefault: false },
  storage: undefined,
  analytics: noopAnalytics,
  build: { version: "dev", contentHash: "", platform: "web" },
};

export const useShell = create<ShellState>(() => PLACEHOLDER);

export function initShell(state: ShellState): void {
  useShell.setState(state);
}

/** Короткий путь для событий: писать `useShell.getState().analytics` каждый раз незачем. */
export function track(event: AnalyticsEvent, payload: AnalyticsPayload = {}): void {
  useShell.getState().analytics(event, payload);
}

/**
 * Сообщить о технической проблеме. Игроку такие подробности не показываются —
 * ему достаётся человеческий текст (docs/27-design-system-and-app-shell.md §8).
 */
export function reportError(scope: string, message: string): void {
  console.warn(`[${scope}] ${message}`);
  track("client_error", { scope, message });
}
