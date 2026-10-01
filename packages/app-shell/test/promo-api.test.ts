import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { createPromoApi, errorKey, rewardLines } from "../src/state/promo-api";
import { hasTranslation, t } from "../src/i18n";
import "../src/i18n/promo";

// Клиент промокода (docs/35-stage4-plan.md WP41): код уходит как набран —
// регистр и раскладку решает сервер; у каждого отказа — свой текст, а что
// легло — по ценности, без нулей.

function server(calls: { path: string; body: unknown }[], answer: unknown): ApiRequest {
  return async <T,>(path: string, schema: object, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>> => {
    calls.push({ path: `${init?.method ?? "GET"} ${path}`, body: init?.body });
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
    return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
  };
}

describe("клиент промокода", () => {
  it("код уходит POST-ом как набран; ответ разбирается схемой, текст команды может быть пустым", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const answer = { credited: { coins: 1_000, gems: 20, shard_common: 0, shard_uncommon: 0 }, capped: false, message: null, campaignId: "c-1", kind: "shared" };
    const result = await createPromoApi(server(calls, answer)).redeem("рубеж 2026");
    expect(result.ok && result.data.credited.gems).toBe(20);
    expect(calls).toEqual([{ path: "POST /api/v1/promo-codes/redeem", body: { code: "рубеж 2026" } }]);
  });

  it("у каждого отказа сервера — свой текст; лимит попыток, связь и прочее — свои", () => {
    const fail = (code: string | undefined, failure: "rejected" | "offline" | "unavailable" = "rejected") => errorKey(code === undefined ? { ok: false, failure } : { ok: false, failure, code });
    for (const reason of ["not_found", "already", "scheduled", "paused", "expired", "exhausted", "used", "platform", "new_players"]) {
      const key = fail(`promo_code_${reason}`);
      expect(key).toBe(`promo.error.${reason}`);
      expect(hasTranslation(key), key).toBe(true);
    }
    expect(fail("rate_limited")).toBe("promo.error.rate_limited");
    expect(fail(undefined, "offline")).toBe("promo.error.offline");
    expect(fail("something_new")).toBe("promo.error.other");
    expect(hasTranslation("promo.error.other")).toBe(true);
  });

  it("что легло — по ценности и без нулей; подпись склоняется", () => {
    expect(rewardLines({ coins: 500, gems: 0, shard_common: 3, shard_uncommon: 1 })).toEqual([
      { resource: "coins", amount: 500 },
      { resource: "shard_uncommon", amount: 1 },
      { resource: "shard_common", amount: 3 },
    ]);
    expect(rewardLines({ coins: 0, gems: 0, shard_common: 0, shard_uncommon: 0 })).toEqual([]);
    expect(t("promo.reward.gems", { amount: "21", n: 21 })).toBe("21 самоцвет");
    expect(t("promo.reward.shard_common", { amount: "3", n: 3 })).toBe("3 обычных осколка");
  });
});
