import { z } from "zod/mini";
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
 */

const sectorSchema = z.object({ resource: z.string(), amount: z.number(), odds: z.number() });
const viewSchema = z.object({ sectors: z.array(sectorSchema), free: z.boolean() });
const spinSchema = z.object({ sector: z.number(), resource: z.string(), amount: z.number(), credited: z.number(), view: viewSchema });

export type WheelView = z.infer<typeof viewSchema>;
export type WheelSector = z.infer<typeof sectorSchema>;
export type WheelSpin = z.infer<typeof spinSchema>;

/** Бесплатную крутку этих суток уже крутили — с другой вкладки или устаревшего экрана. */
export const WHEEL_SPENT = "wheel_spent";

export interface WheelApi {
  view(): Promise<ApiResult<WheelView>>;
  spin(): Promise<ApiResult<WheelSpin>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createWheelApi(request: ApiRequest = apiRequest): WheelApi {
  return {
    view: () => request("/api/v1/wheel", viewSchema, { method: "GET" }),
    spin: () => request("/api/v1/wheel/spin", spinSchema, { method: "POST", body: { source: "free" } }),
  };
}

/** Колесо — только с входом: крутки считает сервер по аккаунту. */
export function wheelAvailable(): boolean {
  return useShell.getState().capabilities.auth !== undefined;
}
