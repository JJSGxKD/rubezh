import type { AppLinkBuilder } from "../ports/app-links.js";
import type { BotIdentity } from "./bot-identity.js";

/**
 * Ссылки через бота: на Mini App — `t.me/<бот>?startapp=<параметр>`, на чат с
 * ботом — `t.me/<бот>?start=<параметр>`. Диплинки `tg://resolve` открывают
 * установленное приложение сразу, без страницы t.me с кнопкой «Открыть в
 * Telegram».
 */
export class TelegramAppLinks implements AppLinkBuilder {
  readonly platform = "telegram" as const;

  constructor(private readonly identity: Pick<BotIdentity, "miniAppLink" | "username">) {}

  launch(startParam: string): string | null {
    const base = this.identity.miniAppLink;
    return base === null ? null : `${base}=${encodeURIComponent(startParam)}`;
  }

  chat(startParam: string): string | null {
    const username = this.identity.username;
    return username === null ? null : `https://t.me/${username}?start=${encodeURIComponent(startParam)}`;
  }

  launchDeep(startParam: string): string | null {
    const username = this.identity.username;
    return username === null ? null : `tg://resolve?domain=${username}&startapp=${encodeURIComponent(startParam)}`;
  }

  chatDeep(startParam: string): string | null {
    const username = this.identity.username;
    return username === null ? null : `tg://resolve?domain=${username}&start=${encodeURIComponent(startParam)}`;
  }
}
