/**
 * Внешняя ссылка из Mini App — канал проекта из задания, страница партнёра
 * (docs/35-stage4-plan.md Р52). Ссылку Telegram открывает `openTelegramLink`:
 * канал откроется в самом клиенте, и игра на свежем клиенте не закроется.
 * Любую другую — `openLink`, во встроенном браузере Telegram. Вне клиента, в
 * старом клиенте или при сбое моста — обычным окном браузера: кнопка не
 * должна молча не срабатывать.
 */

/** Срез SDK, который нужен ссылкам: так функция проверяется без клиента Telegram. */
export interface LinkSdk {
  telegramAvailable(): boolean;
  openTelegram(url: string): void;
  linkAvailable(): boolean;
  open(url: string): void;
  browser(url: string): void;
}

const TELEGRAM_HOSTS: ReadonlySet<string> = new Set(["t.me", "telegram.me"]);

export function isTelegramLink(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === "https:" && TELEGRAM_HOSTS.has(parsed.hostname);
}

export function openLinkWith(sdk: LinkSdk, url: string): void {
  try {
    if (isTelegramLink(url) && sdk.telegramAvailable()) return sdk.openTelegram(url);
    if (sdk.linkAvailable()) return sdk.open(url);
  } catch (error: unknown) {
    // Мост с клиентом оборвался или клиент отверг вызов — пусть откроет браузер.
    console.warn("Ссылка через Telegram не открылась:", error);
  }
  sdk.browser(url);
}
