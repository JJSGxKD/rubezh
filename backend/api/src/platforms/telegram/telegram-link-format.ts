/**
 * Форму ссылки Telegram знает только этот файл (Р100, docs/35-stage4-plan.md):
 * при смене домена правится источник `LinkOrigin`, а не модули, которые
 * просят ссылку. Тест-сторож `telegram-link-single-point.test.ts` не даёт
 * зашить домен или диплинк строкой где-то ещё.
 */

/** Откуда начинается веб-ссылка Telegram: схема и домен, без пути и слэша на конце. */
export interface LinkOrigin {
  origin(): string;
}

export const TELEGRAM_LINK_ORIGIN = Symbol("TELEGRAM_LINK_ORIGIN");
export const DEFAULT_LINK_ORIGIN = "https://t.me";
/** Домен спрашивают в момент сборки ссылки, а не при старте: настройка из панели не требует перезапуска. */
export const fixedLinkOrigin: LinkOrigin = { origin: () => DEFAULT_LINK_ORIGIN };

/** `app` — Mini App (`startapp`), `chat` — чат с ботом (`start`). */
export type BotLinkKind = "app" | "chat";

const PARAM = { app: "startapp", chat: "start" } as const;

/** `https://t.me/<бот>?startapp` без параметра; с параметром — `…?startapp=<параметр>`. */
export function webLink(origin: string, username: string, kind: BotLinkKind, startParam?: string): string {
  const base = `${origin}/${username}?${PARAM[kind]}`;
  return startParam === undefined ? base : `${base}=${encodeURIComponent(startParam)}`;
}

/** Тот же адрес диплинком в установленный клиент; от домена не зависит. */
export function deepLink(username: string, kind: BotLinkKind, startParam: string): string {
  return `tg://resolve?domain=${username}&${PARAM[kind]}=${encodeURIComponent(startParam)}`;
}
