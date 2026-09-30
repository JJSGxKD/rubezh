import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { useShell } from "./shell";

/**
 * Награда дня с сервера (docs/35-stage4-plan.md Р45, WP13): какой сегодня
 * день и забрано ли, решает сервер по московским суткам — по часам
 * устройства награду получали бы переводом времени.
 *
 * Модуль грузится вместе с экраном награды дня — первой загрузке он не нужен.
 */

const daySchema = z.object({ day: z.number(), coins: z.number(), shards: z.number(), claimed: z.boolean(), today: z.boolean() });
const viewSchema = z.object({ week: z.number(), days: z.array(daySchema), canClaim: z.boolean(), step: z.number(), nextStep: z.number() });
const claimSchema = z.object({ claimed: z.boolean(), coins: z.number(), shards: z.number(), view: viewSchema });

export type DailyView = z.infer<typeof viewSchema>;
export type DailyDay = z.infer<typeof daySchema>;
export type DailyClaim = z.infer<typeof claimSchema>;

export interface DailyApi {
  view(): Promise<ApiResult<DailyView>>;
  claim(): Promise<ApiResult<DailyClaim>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createDailyApi(request: ApiRequest = apiRequest): DailyApi {
  return {
    view: () => request("/api/v1/daily", viewSchema, { method: "GET" }),
    claim: () => request("/api/v1/daily/claim", claimSchema, { method: "POST" }),
  };
}

/** Награда дня — только с входом: прогресс живёт на сервере. */
export function dailyAvailable(): boolean {
  return useShell.getState().capabilities.auth !== undefined;
}

/** День недели награды, 1…7, — для подписи и события. */
export function dayOfWeek(day: DailyDay, days: readonly DailyDay[]): number {
  return days.indexOf(day) + 1;
}
