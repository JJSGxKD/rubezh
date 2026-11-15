import {
  SOURCE_IMAGE_MAX_BYTES,
  SourceAvatarRejectedError,
  SourceAvatarUnavailableError,
  readBounded,
  type SourceAvatar,
  type SourceImage,
  type SourceImageType,
  type SourceRef,
} from "../ports/source-avatar.js";
import { TelegramApiError, type TelegramBotApi } from "./telegram-bot-api.js";
import { DEFAULT_LINK_ORIGIN, type LinkOrigin } from "./telegram-link-format.js";

/**
 * Аватарка источника задания в Telegram (docs/35-stage4-plan.md Р158).
 *
 * - **Канал** — Bot API: `getChat` отдаёт `big_file_id`, `getFile` и файловый
 *   хост — байты. Бот уже администратор канала (иначе не работает проверка
 *   подписки). Бота в канале нет (400 или 403 при `@имени`) — публичная
 *   страница, как у бота.
 * - **Бот и Mini App** — Bot API чужих ботов не видит, поэтому источник —
 *   публичная страница `<домен ссылок>/<имя>[/<приложение>]`: из неё берётся
 *   `og:image`, и картинка скачивается, только если она на CDN Telegram.
 *   Любой другой хост — `null`: так выглядит заглушка «нет картинки»
 *   (`telegram.org/img/…`), и так закрыт запрос сервера на произвольный адрес.
 *
 * Пределы: запрос 5 с, страница до 512 КБ, картинка до 2 МБ, перенаправлениям
 * не следуем, тип картинки — по сигнатуре байтов, а не по заголовку.
 */

export type SourceBotApi = Pick<TelegramBotApi, "getChatPhoto" | "downloadFile">;

const REQUEST_MS = 5_000;
const PAGE_MAX_BYTES = 512 * 1024;
const USER_AGENT = "Mozilla/5.0 (compatible; LinkPreview)";

const BOT_NAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
/** Короткое имя Mini App у BotFather бывает короче имени бота: от двух знаков. */
const APP_NAME = /^[A-Za-z][A-Za-z0-9_]{1,31}$/;
const CHANNEL_NAME = /^@([A-Za-z][A-Za-z0-9_]{3,31})$/;
const CHANNEL_ID = /^-?\d{1,20}$/;
const CDN_HOST = /^cdn\d{1,3}\.(?:telesco\.pe|cdn-telegram\.org)$/;
const DEFAULT_HOST = new URL(DEFAULT_LINK_ORIGIN).host;

export interface BotLink {
  bot: string;
  /** короткое имя Mini App; `null` — ссылка на самого бота */
  app: string | null;
}

/**
 * Ссылка на бота или Mini App: https, домен — `t.me` или домен ссылок из
 * настройки, путь `/<имя>` или `/<имя>/<приложение>`. Параметры запуска
 * (`?start=…`, `?startapp=…`) отбрасываются: на страницу они не нужны.
 */
export function parseBotLink(url: string, linkHost: string): BotLink | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "") return null;
  if (parsed.hostname !== DEFAULT_HOST && parsed.hostname !== linkHost.toLowerCase()) return null;
  const segments = parsed.pathname.split("/").slice(1);
  if (segments.at(-1) === "") segments.pop();
  const [bot, app] = segments;
  if (bot === undefined || segments.length > 2 || !BOT_NAME.test(bot)) return null;
  if (app !== undefined && !APP_NAME.test(app)) return null;
  return { bot, app: app ?? null };
}

const META_TAG = /<meta\b[^>]*>/gi;
const ATTRIBUTE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Адрес из `<meta property="og:image">` при любом порядке атрибутов; нет — `null`. */
export function ogImageOf(html: string): string | null {
  for (const tag of html.matchAll(META_TAG)) {
    const attributes = new Map<string, string>();
    for (const attribute of tag[0].matchAll(ATTRIBUTE)) attributes.set((attribute[1] ?? "").toLowerCase(), attribute[2] ?? attribute[3] ?? "");
    if (attributes.get("property")?.trim().toLowerCase() !== "og:image") continue;
    const content = attributes.get("content")?.trim() ?? "";
    if (content !== "") return content.replaceAll("&amp;", "&");
  }
  return null;
}

/** Картинку можно скачать: https и CDN Telegram (`cdn<N>.telesco.pe`, `cdn<N>.cdn-telegram.org`), без порта и учётных данных. */
export function isTelegramCdn(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.port === "" && CDN_HOST.test(parsed.hostname);
}

/** Тип картинки по первым байтам: JPEG, PNG, WebP; остальное — `null`. */
export function imageTypeOf(bytes: Uint8Array): SourceImageType | null {
  const at = (offset: number, ...expected: number[]) => expected.every((byte, index) => bytes[offset + index] === byte);
  if (bytes.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (bytes.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (bytes.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

function imageOf(bytes: Uint8Array): SourceImage | null {
  const contentType = imageTypeOf(bytes);
  return contentType === null ? null : { bytes, contentType };
}

export class TelegramSourceAvatar implements SourceAvatar {
  readonly platform = "telegram" as const;

  /**
   * @param origin домен ссылок из настройки панели: страница бота берётся с него
   * @param fetchImpl `fetch` клиента исходящих с меткой `telegram.web`
   * @param enabled бот настроен — без токена Bot API спросить некого
   */
  constructor(
    private readonly api: SourceBotApi,
    private readonly origin: LinkOrigin,
    private readonly fetchImpl: typeof fetch,
    private readonly enabled: boolean,
  ) {}

  async fetch(source: SourceRef, signal: AbortSignal): Promise<SourceImage | null> {
    if (source.kind === "channel") return await this.channel(source.chat.trim(), signal);
    const link = parseBotLink(source.url, this.linkHost());
    if (link === null) throw new SourceAvatarRejectedError("Ссылка не похожа на бота или Mini App Telegram");
    return await this.fromPage(link.bot, link.app, signal);
  }

  private async channel(chat: string, signal: AbortSignal): Promise<SourceImage | null> {
    const name = CHANNEL_NAME.exec(chat)?.[1] ?? null;
    if (name === null && !CHANNEL_ID.test(chat)) throw new SourceAvatarRejectedError("Канал — @имя или числовой id");
    if (this.enabled) {
      try {
        const fileId = await this.api.getChatPhoto(chat, signal);
        if (fileId === null) return null;
        const bytes = await this.api.downloadFile(fileId, SOURCE_IMAGE_MAX_BYTES, signal);
        return bytes === null ? null : imageOf(bytes);
      } catch (error: unknown) {
        if (!(error instanceof TelegramApiError)) throw error;
        // Бота в канале нет или чат ему закрыт: повтор не поможет, но у публичного канала есть страница.
        if (error.errorCode !== 400 && error.errorCode !== 403) throw new SourceAvatarUnavailableError(error.message);
      }
    }
    return name === null ? null : await this.fromPage(name, null, signal);
  }

  private async fromPage(bot: string, app: string | null, signal: AbortSignal): Promise<SourceImage | null> {
    const html = await this.get(`${this.origin.origin()}/${bot}${app === null ? "" : `/${app}`}`, PAGE_MAX_BYTES, signal);
    if (html === null) return null;
    const image = ogImageOf(new TextDecoder().decode(html));
    // Заглушка «нет картинки» лежит на telegram.org, а чужой адрес из страницы сервер не открывает вовсе.
    if (image === null || !isTelegramCdn(image)) return null;
    const bytes = await this.get(image, SOURCE_IMAGE_MAX_BYTES, signal);
    return bytes === null ? null : imageOf(bytes);
  }

  /**
   * Один запрос с пределом по сроку и размеру. Перенаправление и любой ответ,
   * кроме 200, — `null`; сеть, 5xx и лимит — «площадка не ответила».
   */
  private async get(url: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]),
      });
    } catch {
      throw new SourceAvatarUnavailableError("Telegram не ответил");
    }
    if (response.status >= 500 || response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      throw new SourceAvatarUnavailableError(`Telegram ответил ${String(response.status)}`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    try {
      return await readBounded(response, maxBytes);
    } catch {
      throw new SourceAvatarUnavailableError("Telegram не дослал ответ");
    }
  }

  /** Хост домена ссылок; настройка не разобралась — `t.me`. */
  private linkHost(): string {
    const origin = this.origin.origin();
    return URL.canParse(origin) ? new URL(origin).host : DEFAULT_HOST;
  }
}
