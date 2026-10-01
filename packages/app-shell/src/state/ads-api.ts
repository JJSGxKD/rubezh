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
  }),
  z.object({ available: z.literal(false), reason: z.string(), retryAt: z.nullable(z.string()) }),
]);

export type AdOffer = z.infer<typeof offerSchema>;

/** Место отдыхает после награды — кулдаун места (`retryAt`). */
export const AD_COOLDOWN = "cooldown";

export interface AdsApi {
  offer(place: AdPlace): Promise<ApiResult<AdOffer>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createAdsApi(request: ApiRequest = apiRequest): AdsApi {
  return {
    offer: (place) => request("/api/v1/ads/sessions", offerSchema, { method: "POST", body: { place } }),
  };
}

/** Сессия без ролика — её сразу забирают у хозяина места; `null` — нужен показ. */
export function passSession(offer: AdOffer): string | null {
  return offer.available && (offer.pass ?? null) !== null ? offer.sessionId : null;
}
