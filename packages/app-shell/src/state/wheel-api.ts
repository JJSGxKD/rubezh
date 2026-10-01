import { z } from "zod/mini";
import { AD_COOLDOWN, passSession, type AdsApi } from "./ads-api";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { useShell } from "./shell";

/**
 * Колесо с сервера (docs/35-stage4-plan.md WP13, docs/07-monetization-and-ads.md
 * §7): сектора с наградой уровня игрока и шансами, крутка. Что выпало, решает
 * сервер — клиент только докручивает колесо до сектора из ответа: по броску
 * на устройстве колесо крутили бы до джекпота.
 *
 * Модуль грузится вместе с экраном колеса — первой загрузке он не нужен.
 *
 * Ресурс сектора — строкой, а не перечислением: сервер новее клиента может
 * положить на колесо то, чего клиент ещё не знает, и сектор нарисуется
 * нейтрально, а не уронит экран.
 *
 * Крутка за рекламу ждёт показа роликов в клиенте (WP12); у VIP ролика нет
 * (§3.6) — его крутка идёт уже сейчас: выдача показа отдаёт выполненную
 * сессию, и колесо крутится по ней, после кулдауна места.
 */

const sectorSchema = z.object({ resource: z.string(), amount: z.number(), odds: z.number() });
/** Крутка за рекламу: есть ли она, когда пройдёт кулдаун и нужен ли ролик (`pass` — VIP без него). */
const adSchema = z.object({ available: z.boolean(), readyAt: z.nullable(z.string()), pass: z.optional(z.nullable(z.string())) });
const viewSchema = z.object({ sectors: z.array(sectorSchema), free: z.boolean(), ad: z.optional(adSchema) });
const spinSchema = z.object({ sector: z.number(), resource: z.string(), amount: z.number(), credited: z.number(), view: viewSchema });

export type WheelView = z.infer<typeof viewSchema>;
export type WheelSector = z.infer<typeof sectorSchema>;
export type WheelSpin = z.infer<typeof spinSchema>;

/** Бесплатную крутку этих суток уже крутили — с другой вкладки или устаревшего экрана. */
export const WHEEL_SPENT = "wheel_spent";
/** Крутка за рекламу на кулдауне места — экран устарел. */
export const WHEEL_AD_COOLDOWN = "ad_cooldown";
/** Ролик нужен, а показывать его клиент ещё не умеет: VIP кончился, пока экран был открыт. */
export const WHEEL_AD_NEEDS_VIDEO = "ad_needs_video";

export interface WheelApi {
  view(): Promise<ApiResult<WheelView>>;
  spin(): Promise<ApiResult<WheelSpin>>;
  spinAd(sessionId: string): Promise<ApiResult<WheelSpin>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createWheelApi(request: ApiRequest = apiRequest): WheelApi {
  return {
    view: () => request("/api/v1/wheel", viewSchema, { method: "GET" }),
    spin: () => request("/api/v1/wheel/spin", spinSchema, { method: "POST", body: { source: "free" } }),
    spinAd: (sessionId) => request("/api/v1/wheel/spin", spinSchema, { method: "POST", body: { source: "ad", sessionId } }),
  };
}

/** Кнопка крутки за рекламу: без пропуска — «скоро», у VIP — крутка или отсчёт до конца кулдауна. */
export type AdSpinState = { kind: "soon" } | { kind: "ready" } | { kind: "wait"; untilMs: number };

export function adSpinState(view: Pick<WheelView, "ad">, nowMs: number): AdSpinState {
  const ad = view.ad;
  if (ad === undefined || (ad.pass ?? null) === null) return { kind: "soon" };
  if (ad.readyAt === null) return { kind: "ready" };
  const untilMs = Date.parse(ad.readyAt);
  return untilMs > nowMs ? { kind: "wait", untilMs } : { kind: "ready" };
}

/**
 * Крутка VIP без ролика: сессия места от модуля рекламы — сразу в крутку.
 * Без пропуска нужен ролик — отказ с кодом, а не показ, которого клиент
 * ещё не умеет.
 */
export async function spinWithPass(ads: Pick<AdsApi, "offer">, wheel: Pick<WheelApi, "spinAd">): Promise<ApiResult<WheelSpin>> {
  const offer = await ads.offer("wheel_spin");
  if (!offer.ok) return offer;
  if (!offer.data.available) return { ok: false, failure: "rejected", code: offer.data.reason === AD_COOLDOWN ? WHEEL_AD_COOLDOWN : WHEEL_AD_NEEDS_VIDEO };
  const sessionId = passSession(offer.data);
  if (sessionId === null) return { ok: false, failure: "rejected", code: WHEEL_AD_NEEDS_VIDEO };
  return await wheel.spinAd(sessionId);
}

/** Колесо — только с входом: крутки считает сервер по аккаунту. */
export function wheelAvailable(): boolean {
  return useShell.getState().capabilities.auth !== undefined;
}
