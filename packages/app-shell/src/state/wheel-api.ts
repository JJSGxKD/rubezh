import { z } from "zod/mini";
import type { AdWatchResult } from "./ad-watch";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { RESTRICTED_CODE } from "./restrictions";
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
 * Крутка за рекламу (WP12) — после досмотренного ролика, по сессии показа;
 * у VIP ролика нет (§3.6), и сессия приходит сразу. Кулдаун места общий.
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
/** Ролик закрыт раньше конца — крутки нет. */
export const WHEEL_AD_CLOSED = "ad_closed";
/** Ни у одной сети сейчас нет рекламы. */
export const WHEEL_NO_ADS = "no_ads";
/** Ролик не загрузился или шаг не дошёл до сервера — можно попробовать ещё раз. */
export const WHEEL_AD_FAILED = "ad_failed";

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

/**
 * Кнопка крутки за рекламу: `hidden` — рекламы для площадки нет (и нет
 * VIP), `ready` — можно, `wait` — место отдыхает. `pass` — VIP, без ролика.
 */
export type AdSpinState = { kind: "hidden" } | { kind: "ready"; pass: boolean } | { kind: "wait"; untilMs: number; pass: boolean };

/** `playable` — площадка умеет показывать ролики сетей; без этого крутка за рекламу есть только у VIP. */
export function adSpinState(view: Pick<WheelView, "ad">, nowMs: number, playable: boolean): AdSpinState {
  const ad = view.ad;
  const pass = (ad?.pass ?? null) !== null;
  if (ad === undefined || !ad.available || (!pass && !playable)) return { kind: "hidden" };
  const untilMs = ad.readyAt === null ? 0 : Date.parse(ad.readyAt);
  return untilMs > nowMs ? { kind: "wait", untilMs, pass } : { kind: "ready", pass };
}

/**
 * Крутка за рекламу: ролик (или VIP) — и сессия показа сразу в крутку.
 * Исход без крутки — отказом с кодом, по которому экран скажет игроку, что
 * случилось. `rewarded` — награда выдана: для `ad_reward_claimed`.
 */
export async function spinForAd(
  watch: () => Promise<AdWatchResult>,
  wheel: Pick<WheelApi, "spinAd">,
  rewarded: (source: "ad" | "pass") => void,
): Promise<ApiResult<WheelSpin>> {
  const watched = await watch();
  switch (watched.kind) {
    case "watched": {
      const spin = await wheel.spinAd(watched.sessionId);
      if (spin.ok) rewarded(watched.source);
      return spin;
    }
    case "cooldown":
      return { ok: false, failure: "rejected", code: WHEEL_AD_COOLDOWN };
    case "closed":
      return { ok: false, failure: "rejected", code: WHEEL_AD_CLOSED };
    case "no_ads":
      return { ok: false, failure: "rejected", code: WHEEL_NO_ADS };
    case "restricted":
      // Тот же отказ, что у сервера: экран покажет плашку, как везде.
      return { ok: false, failure: "disabled", code: RESTRICTED_CODE };
    case "failed":
      return { ok: false, failure: "unavailable", code: WHEEL_AD_FAILED };
  }
}

/** Колесо — только с входом: крутки считает сервер по аккаунту. */
export function wheelAvailable(): boolean {
  return useShell.getState().capabilities.auth !== undefined;
}
