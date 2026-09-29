import type { AppLinkBuilder } from "../ports/app-links.js";
import type { BotIdentity } from "./bot-identity.js";

/** Ссылки через бота: на Mini App — `t.me/<бот>?startapp=<параметр>`, на чат с ботом — `t.me/<бот>?start=<параметр>`. */
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
}
