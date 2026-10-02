import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";

/**
 * Выдача показа рекламы в месте (docs/35-stage4-plan.md §3.7, WP12): сервер
 * выбирает сеть и блок, а у VIP отдаёт сессию, уже выполненную без ролика
 * (§3.6). Награду выдаёт хозяин места — колесо, удвоение — по идентификатору
 * сессии; модуль рекламы ручается только за показ.
 *
 * Грузится с экраном места — первой загрузке он не нужен. Сеть, условие
 * успеха и причина отказа — строками: сервер новее клиента может завести то,
 * чего клиент ещё не знает.
 */

export const AD_PLACES = ["second_chance", "wheel_spin", "run_double", "task", "interstitial"] as const;
export type AdPlace = (typeof AD_PLACES)[number];

const nullableText = z.nullable(z.string());

/** Объявление для нашего блока — `AdCreative` из shared-types; адреса проверил сервер. */
const creativeSchema = z.object({
  ad: z.object({
    id: z.string(),
    title: nullableText,
    description: nullableText,
    text: nullableText,
    image: nullableText,
    icon: nullableText,
    button: nullableText,
    link: z.string(),
    advertiser: z.string(),
  }),
  viewSec: z.number().check(z.positive(), z.maximum(120)),
});

export type AdCreativeOffer = z.infer<typeof creativeSchema>;

const offerSchema = z.union([
  z.object({
    available: z.literal(true),
    sessionId: z.string(),
    network: z.string(),
    blockId: z.nullable(z.string()),
    /** что показать — видео за награду, межстраничную или задание; сервер до профилей сетей поля не отдавал */
    format: z.optional(z.string()),
    /** публичные ключи сети (pubId, appId) — их ждёт SDK вместе с блоком */
    keys: z.optional(z.record(z.string(), z.string())),
    success: z.string(),
    expiresAt: z.string(),
    /** ролик не нужен — у VIP; сервер до пропуска поля не отдавал */
    pass: z.optional(z.nullable(z.string())),
    /** тестовые показы сети — по настройке из панели; сервер до неё поля не отдавал */
    debug: z.optional(z.boolean()),
    /** креатив сети с API — его рисует наш блок, а не SDK; сервер до Taddy по API поля не отдавал */
    creative: z.optional(z.nullable(creativeSchema)),
  }),
  z.object({ available: z.literal(false), reason: z.string(), retryAt: z.nullable(z.string()) }),
]);

export type AdOffer = z.infer<typeof offerSchema>;

/** Место отдыхает после награды — кулдаун места (`retryAt`). */
export const AD_COOLDOWN = "cooldown";

/**
 * Устройство для выдачи: у блока сети может стоять «только телефоны» —
 * сеть не работает на десктопе. `null` — не знаем, и сервер не предложит
 * блоков с ограничением по устройству.
 */
export const AD_DEVICES = ["android", "ios", "desktop", "web"] as const;
export type AdDevice = (typeof AD_DEVICES)[number];

/**
 * Шаг показа для воронки сервера. Засчитать выполнение клиент может только
 * досмотру (`completed`); `shown` — ролик был, но награды нет; `clicked` —
 * игрок открыл объявление нашего блока.
 */
export type AdStep = { outcome: "shown" } | { outcome: "completed" } | { outcome: "clicked" } | { outcome: "failed"; reason: string };

/**
 * Кто смотрит — для сети с API, которая подбирает рекламу по языку и
 * премиуму (Р78). Со слов клиента площадки: на выдачу и награду не влияет.
 */
export interface AdViewerHints {
  device: AdDevice | null;
  language: string | null;
  premium: boolean | null;
}

const reportSchema = z.object({ ok: z.literal(true) });

export interface AdsApi {
  offer(place: AdPlace, viewer?: AdViewerHints | null): Promise<ApiResult<AdOffer>>;
  report(sessionId: string, step: AdStep): Promise<ApiResult<unknown>>;
}

/** Язык — как его ждёт сервер: `ru`, `pt-br`; что-то иное — не передаём. */
const LANGUAGE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})?$/;

/** Тело запроса выдачи: место и только те подсказки, что известны. */
export function offerBody(place: AdPlace, viewer: AdViewerHints | null): Record<string, string | boolean> {
  if (viewer === null) return { place };
  return {
    place,
    ...(viewer.device === null ? {} : { device: viewer.device }),
    ...(viewer.language !== null && LANGUAGE.test(viewer.language) ? { language: viewer.language } : {}),
    ...(viewer.premium === null ? {} : { premium: viewer.premium }),
  };
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createAdsApi(request: ApiRequest = apiRequest): AdsApi {
  return {
    offer: (place, viewer = null) => request("/api/v1/ads/sessions", offerSchema, { method: "POST", body: offerBody(place, viewer) }),
    report: (sessionId, step) => request(`/api/v1/ads/sessions/${encodeURIComponent(sessionId)}/result`, reportSchema, { method: "POST", body: step }),
  };
}

/**
 * Устройство по клиенту площадки: ролики сетей показывает только Telegram,
 * а его клиент называет себя сам и точнее user-agent — веб-версия на
 * телефоне всё равно `web`. Незнакомый клиент — `null`.
 */
export function adDeviceOf(clientPlatform: string | null): AdDevice | null {
  const client = clientPlatform?.toLowerCase() ?? "";
  if (client.startsWith("android")) return "android";
  if (client === "ios") return "ios";
  if (client === "tdesktop" || client === "macos" || client === "unigram") return "desktop";
  if (client.startsWith("web")) return "web";
  return null;
}

/** Сессия без ролика — её сразу забирают у хозяина места; `null` — нужен показ. */
export function passSession(offer: AdOffer): string | null {
  return offer.available && (offer.pass ?? null) !== null ? offer.sessionId : null;
}
