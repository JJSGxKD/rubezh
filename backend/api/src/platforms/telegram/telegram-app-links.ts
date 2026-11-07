import type { AppLinkBuilder } from "../ports/app-links.js";
import type { BotIdentity } from "./bot-identity.js";
import { deepLink, fixedLinkOrigin, webLink, type LinkOrigin } from "./telegram-link-format.js";

/**
 * Хвост, который дописывается к параметру без кодирования: только знаки параметра Telegram и
 * фигурные скобки макросов. Всё остальное (`&`, `?`, `#`, пробел) начало бы новый параметр адреса
 * или оборвало бы его, поэтому такой адрес не собираем вовсе.
 */
const RAW_TAIL = /^[A-Za-z0-9_\-{}]+$/;

/**
 * Ссылки через бота: на Mini App — `t.me/<бот>?startapp=<параметр>`, на чат с
 * ботом — `t.me/<бот>?start=<параметр>`. Диплинки `tg://resolve` открывают
 * установленное приложение сразу, без страницы t.me с кнопкой «Открыть в
 * Telegram». Форму ссылки знает `telegram-link-format.ts`, домен — `LinkOrigin`:
 * в проде `launch` (через `identity.miniAppLink`) и `chat` получают один и тот же.
 */
export class TelegramAppLinks implements AppLinkBuilder {
  readonly platform = "telegram" as const;

  constructor(
    private readonly identity: Pick<BotIdentity, "miniAppLink" | "username">,
    private readonly origin: LinkOrigin = fixedLinkOrigin,
  ) {}

  launch(startParam: string, rawTail?: string): string | null {
    const base = this.identity.miniAppLink;
    if (base === null) return null;
    const head = `${base}=${encodeURIComponent(startParam)}`;
    if (rawTail === undefined || rawTail === "") return head;
    return RAW_TAIL.test(rawTail) ? `${head}${rawTail}` : null;
  }

  chat(startParam: string): string | null {
    const username = this.identity.username;
    return username === null ? null : webLink(this.origin.origin(), username, "chat", startParam);
  }

  launchDeep(startParam: string): string | null {
    const username = this.identity.username;
    return username === null ? null : deepLink(username, "app", startParam);
  }

  chatDeep(startParam: string): string | null {
    const username = this.identity.username;
    return username === null ? null : deepLink(username, "chat", startParam);
  }
}
