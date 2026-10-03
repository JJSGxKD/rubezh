import { Logger } from "@nestjs/common";
import { z } from "zod";

/**
 * Taddy по API (docs/35-stage4-plan.md WP12, часть 9, Р78): креатив для
 * нашего рекламного блока, отметки показа и досмотра, запуск бота.
 *
 * Контракт сверен с SDK Taddy (`taddy-sdk-web`: типы 1.3.17, вызовы 1.2.12 —
 * `ads/get`, `ads/impressions`, `ads/view-through`, `events/start`) и с
 * рабочей интеграцией `vpnsibcom_api` (`modules/ads/taddy.service.ts`).
 * Ключ один — `pubId` в теле запроса; секрета у этих вызовов нет.
 *
 * Перенос — адаптация (docs/13-reuse-from-vpnsibcom.md §1): в источнике
 * `axios` без таймаута, ответ — через `as`, ошибка — в лог целиком вместе с
 * данными игрока. Здесь — таймаут у каждого вызова, ответ разбирается
 * схемой, в лог уходит только код отказа.
 */

export const TADDY_API_URL = "https://api.taddy.pro/v1";
/** Креатив ждёт выдача показа, а её — игрок у кнопки: дольше — сеть пропускается. */
export const TADDY_AD_TIMEOUT_MS = 2_500;
/** Отметки показа и запуска идут мимо игрока — им можно подождать дольше. */
export const TADDY_EVENT_TIMEOUT_MS = 5_000;

/**
 * Игрок для Taddy — столько, сколько сети нужно для гео и антифрода, и не
 * больше: имён и юзернейма Taddy не получает. Адрес и браузер — из запроса
 * игрока к нам: запрос к Taddy идёт с сервера (`origin: "server"`), и без
 * них сеть видела бы адрес нашего сервера.
 */
export interface TaddyUser {
  /** Telegram ID — числом, как ждёт Taddy; у Telegram он укладывается в 52 бита */
  id: number;
  language?: string;
  premium?: boolean;
  ip?: string;
  userAgent?: string;
}

/** Объявление Taddy — уже проверенное: адреса только https, пустые строки — `null`. */
export interface TaddyAd {
  id: string;
  title: string | null;
  description: string | null;
  text: string | null;
  image: string | null;
  icon: string | null;
  button: string | null;
  link: string;
}

/**
 * Чем кончился запрос креатива: `no_fill` — рекламы для игрока нет, это не
 * поломка; `invalid` — ответ без ссылки или с небезопасным адресом;
 * `timeout` и `api_error` — сеть не ответила или ответила ошибкой.
 */
export type TaddyAdResult = { kind: "ad"; ad: TaddyAd } | { kind: "none"; reason: "no_fill" | "invalid" | "timeout" | "api_error" };

export interface TaddyApi {
  /** Креатив межстраничного формата — его рисует наш рекламный блок. `timeoutMs` — короче обычного, когда ждёт старт забега. */
  getAd(pubId: string, user: TaddyUser, timeoutMs?: number): Promise<TaddyAdResult>;
  /** Креатив показан игроку — Taddy считает показ. */
  impression(pubId: string, user: TaddyUser, adId: string): Promise<void>;
  /** Креатив досмотрен — то же, что SDK Taddy шлёт после отсчёта своего блока. */
  viewThrough(pubId: string, user: TaddyUser, adId: string): Promise<void>;
  /** Игрок запустил бота — так Taddy учитывает аудиторию бота. */
  start(pubId: string, user: TaddyUser, startParam: string | null): Promise<void>;
}

const TEXT_MAX = { title: 200, description: 1000, text: 1000, button: 60 } as const;

const optionalText = z.string().nullish();

const adSchema = z.object({
  id: z.union([z.string().min(1).max(128), z.number().int()]).transform(String),
  title: optionalText,
  description: optionalText,
  text: optionalText,
  image: optionalText,
  icon: optionalText,
  button: optionalText,
  link: z.string(),
});

const getAdSchema = z.object({ result: adSchema.nullish(), error: z.string().nullish() });

/** Адрес из ответа сети — только https: `javascript:` и `http:` в наш блок не попадут. */
export function httpsUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    // Не адрес вовсе — то же, что адреса нет: креатив без картинки, а без ссылки он отбрасывается.
    return null;
  }
}

function clip(value: string | null | undefined, max: number): string | null {
  const text = value?.trim() ?? "";
  return text === "" ? null : text.slice(0, max);
}

/** Объявление из ответа или причина, по которой его нет. Без ссылки и без того, что показать, — не объявление. */
export function adOf(raw: unknown): TaddyAdResult {
  const parsed = getAdSchema.safeParse(raw);
  if (!parsed.success) return { kind: "none", reason: "invalid" };
  if (parsed.data.error !== null && parsed.data.error !== undefined && parsed.data.error !== "") return { kind: "none", reason: "api_error" };
  const result = parsed.data.result;
  if (result === null || result === undefined) return { kind: "none", reason: "no_fill" };
  const link = httpsUrl(result.link);
  const ad: TaddyAd = {
    id: result.id,
    title: clip(result.title, TEXT_MAX.title),
    description: clip(result.description, TEXT_MAX.description),
    text: clip(result.text, TEXT_MAX.text),
    image: httpsUrl(result.image),
    icon: httpsUrl(result.icon),
    button: clip(result.button, TEXT_MAX.button),
    link: link ?? "",
  };
  if (link === null || (ad.title === null && ad.image === null)) return { kind: "none", reason: "invalid" };
  return { kind: "ad", ad };
}

export function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** Вызов API Taddy: JSON в теле, срок — у каждого вызова свой. */
export async function postTaddy(fetchImpl: typeof fetch, url: string, body: Record<string, unknown>, timeoutMs: number): Promise<Response> {
  return await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export class HttpTaddyApi implements TaddyApi {
  private readonly logger = new Logger("ads");

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = TADDY_API_URL,
  ) {}

  async getAd(pubId: string, user: TaddyUser, timeoutMs = TADDY_AD_TIMEOUT_MS): Promise<TaddyAdResult> {
    try {
      const response = await this.post("/ads/get", { pubId, user, origin: "server", format: "app-interstitial" }, timeoutMs);
      if (!response.ok) {
        this.warn("taddy_get_failed", { status: response.status });
        return { kind: "none", reason: "api_error" };
      }
      const result = adOf(await response.json());
      if (result.kind === "none" && result.reason !== "no_fill") this.warn("taddy_get_failed", { reason: result.reason });
      return result;
    } catch (error: unknown) {
      const reason = isTimeout(error) ? "timeout" : "api_error";
      this.warn("taddy_get_failed", { reason });
      return { kind: "none", reason };
    }
  }

  async impression(pubId: string, user: TaddyUser, adId: string): Promise<void> {
    await this.event("/ads/impressions", { pubId, user, origin: "server", id: adId });
  }

  async viewThrough(pubId: string, user: TaddyUser, adId: string): Promise<void> {
    await this.event("/ads/view-through", { pubId, user, origin: "server", id: adId });
  }

  async start(pubId: string, user: TaddyUser, startParam: string | null): Promise<void> {
    await this.event("/events/start", { pubId, user, origin: "server", ...(startParam === null ? {} : { start: startParam }) });
  }

  /** Отметка для сети: не дошла — показ уже был, и игроку от этого ни холодно ни жарко; остаётся строка в логе. */
  private async event(path: string, body: Record<string, unknown>): Promise<void> {
    try {
      const response = await this.post(path, body, TADDY_EVENT_TIMEOUT_MS);
      if (!response.ok) this.warn("taddy_event_failed", { path, status: response.status });
    } catch (error: unknown) {
      this.warn("taddy_event_failed", { path, reason: isTimeout(error) ? "timeout" : "network" });
    }
  }

  private async post(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<Response> {
    return await postTaddy(this.fetchImpl, `${this.baseUrl}${path}`, body, timeoutMs);
  }

  /** В лог — путь и код, без игрока: адрес и браузер — личные данные (docs/15-engineering-standards.md §7). */
  private warn(event: string, fields: Record<string, unknown>): void {
    this.logger.warn(JSON.stringify({ module: "ads", event, ...fields }));
  }
}
