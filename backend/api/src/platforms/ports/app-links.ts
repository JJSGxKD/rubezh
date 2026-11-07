import type { PlatformId } from "./platform.js";

/**
 * Ссылка запуска приложения площадки с параметром (docs/24-attribution-and-sharing.md
 * §3.4): редирект ведёт кликнувшего в Mini App, и код клика приходит в
 * параметре запуска. Как собирается ссылка — знает адаптер площадки: у
 * Telegram это `t.me/<бот>?startapp=<параметр>`, и имя бота он узнаёт сам.
 */
export interface AppLinkBuilder {
  readonly platform: PlatformId;
  /**
   * `null` — ссылку сейчас не собрать: бот ещё не представился, площадка без приложения или
   * `rawTail` недопустим. `rawTail` дописывается к параметру как есть, без кодирования: так едут
   * макросы рекламной сети (`{click_id}`), которые сеть ищет в адресе буквально (Р121).
   */
  launch(startParam: string, rawTail?: string): string | null;
  /**
   * Ссылка на чат с ботом площадки со стартовым параметром — не приложение,
   * а сам бот: так подтверждают вход в панель. `null` — не собрать.
   */
  chat(startParam: string): string | null;
  /**
   * Та же ссылка на приложение, но диплинком в установленный клиент: без
   * страницы-переходника площадки. `null` или нет метода — у площадки его нет.
   */
  launchDeep?(startParam: string): string | null;
  /** Чат с ботом диплинком: QR и кнопка входа в панель ведут сразу в клиент. */
  chatDeep?(startParam: string): string | null;
}

export class AppLinks {
  private readonly builders: ReadonlyMap<PlatformId, AppLinkBuilder>;

  constructor(builders: readonly AppLinkBuilder[]) {
    this.builders = new Map(builders.map((builder) => [builder.platform, builder]));
  }

  launch(platform: PlatformId, startParam: string, rawTail?: string): string | null {
    const builder = this.builders.get(platform);
    if (builder === undefined) return null;
    return (rawTail === undefined ? builder.launch(startParam) : builder.launch(startParam, rawTail)) ?? null;
  }

  chat(platform: PlatformId, startParam: string): string | null {
    return this.builders.get(platform)?.chat(startParam) ?? null;
  }

  /** Диплинк на приложение; `null` — у площадки диплинков нет, ведут обычной ссылкой. */
  launchDeep(platform: PlatformId, startParam: string): string | null {
    return this.builders.get(platform)?.launchDeep?.(startParam) ?? null;
  }

  chatDeep(platform: PlatformId, startParam: string): string | null {
    return this.builders.get(platform)?.chatDeep?.(startParam) ?? null;
  }
}
