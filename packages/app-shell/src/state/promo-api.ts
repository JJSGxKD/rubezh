import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { useShell } from "./shell";

/**
 * Ввод промокода (docs/35-stage4-plan.md WP41): сервер находит кампанию,
 * проверяет срок, лимит и кому она, и кладёт награду в кошелёк. Игрок
 * узнаёт причину отказа своими словами: код ошибки сервера — в ключ текста.
 *
 * Модуль грузится вместе с экраном промокода — первой загрузке он не нужен.
 */

const rewardSchema = z.object({ coins: z.number(), gems: z.number(), shard_common: z.number(), shard_uncommon: z.number() });
const resultSchema = z.object({ credited: rewardSchema, capped: z.boolean(), message: z.nullable(z.string()), campaignId: z.string(), kind: z.string() });

export type PromoReward = z.infer<typeof rewardSchema>;
export type PromoResult = z.infer<typeof resultSchema>;

export interface PromoApi {
  redeem(code: string): Promise<ApiResult<PromoResult>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createPromoApi(request: ApiRequest = apiRequest): PromoApi {
  return { redeem: (code) => request("/api/v1/promo-codes/redeem", resultSchema, { method: "POST", body: { code } }) };
}

/** Промокод — только с входом: награда ложится в кошелёк аккаунта. */
export function promoAvailable(): boolean {
  return useShell.getState().capabilities.auth !== undefined;
}

/** Отказы сервера, у которых есть свой текст; остальное — общий «не получилось». */
const REFUSALS = ["not_found", "already", "scheduled", "paused", "expired", "exhausted", "used", "platform", "new_players"] as const;

/** Ключ текста ошибки по ответу сервера. */
export function errorKey(result: Extract<ApiResult<unknown>, { ok: false }>): string {
  const refusal = REFUSALS.find((reason) => result.code === `promo_code_${reason}`);
  if (refusal !== undefined) return `promo.error.${refusal}`;
  if (result.code === "rate_limited") return "promo.error.rate_limited";
  if (result.failure === "offline") return "promo.error.offline";
  return "promo.error.other";
}

/** Что легло — строками для экрана, по порядку ценности; нулевое не показывается. */
export const REWARD_ORDER = ["gems", "coins", "shard_uncommon", "shard_common"] as const satisfies readonly (keyof PromoReward)[];

export function rewardLines(reward: PromoReward): { resource: (typeof REWARD_ORDER)[number]; amount: number }[] {
  return REWARD_ORDER.filter((resource) => reward[resource] > 0).map((resource) => ({ resource, amount: reward[resource] }));
}
