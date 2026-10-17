import type { AppLinkBuilder } from "../ports/app-links.js";
import type { BotIdentity } from "./bot-identity.js";
import { deepLink, fixedLinkOrigin, webLink, type LinkOrigin } from "./telegram-link-format.js";

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

  launch(startParam: string): string | null {
    const base = this.identity.miniAppLink;
    return base === null ? null : `${base}=${encodeURIComponent(startParam)}`;
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
