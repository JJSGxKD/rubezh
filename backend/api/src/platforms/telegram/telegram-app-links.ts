import type { AppLinkBuilder } from "../ports/app-links.js";
import type { BotIdentity } from "./bot-identity.js";

/** Ссылка на Mini App через бота: `https://t.me/<бот>?startapp=<параметр>`. */
export class TelegramAppLinks implements AppLinkBuilder {
  readonly platform = "telegram" as const;

  constructor(private readonly identity: Pick<BotIdentity, "miniAppLink">) {}

  launch(startParam: string): string | null {
    const base = this.identity.miniAppLink;
    return base === null ? null : `${base}=${encodeURIComponent(startParam)}`;
  }
}
