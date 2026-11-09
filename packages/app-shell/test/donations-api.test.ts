import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { createDonationsApi } from "../src/state/donations-api";
import { leaderboardSchema } from "../src/state/runs-api";

// Клиент донатов (docs/35-stage4-plan.md, Р109; tasks/T-0158): одним запросом
// всё, что решает сервер; счёт — тот же, что у магазина; пределы и список
// сумм клиент не придумывает.

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

function server(sent: Sent[], answer: unknown): ApiRequest {
  return async <T,>(path: string, schema: object, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>> => {
    sent.push({ method: init?.method ?? "GET", path, body: init?.body });
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
    return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
  };
}

const STARS = { min: 1, max: 10_000, presets: [50, 250, 1000], mode: "live" };
const TRIBUTE = { url: "https://t.me/tribute/app", way: "tribute_telegram" };

describe("витрина доната", () => {
  it("одним GET без тела; ответ со звёздами и ссылкой разбирается как есть", async () => {
    const sent: Sent[] = [];
    const result = await createDonationsApi(server(sent, { stars: STARS, tribute: TRIBUTE, supporter: false })).view();
    expect(sent).toEqual([{ method: "GET", path: "/api/v1/donations", body: undefined }]);
    expect(result.ok && result.data).toEqual({ stars: STARS, tribute: TRIBUTE, supporter: false });
  });

  it("звёзд нет (оплата выключена, покупки закрыты) — это ответ, а не ошибка", async () => {
    const result = await createDonationsApi(server([], { stars: null, tribute: TRIBUTE, supporter: true })).view();
    expect(result.ok && result.data.stars).toBeNull();
    expect(result.ok && result.data.supporter).toBe(true);
  });

  it("ссылки в ответе нет вовсе или она пуста — это тоже ответ", async () => {
    expect((await createDonationsApi(server([], { stars: STARS, supporter: false })).view()).ok).toBe(true);
    expect((await createDonationsApi(server([], { stars: null, tribute: null, supporter: false })).view()).ok).toBe(true);
  });

  it("готовые суммы не списком, нет предела, режим незнакомый или нет признака знака — отказ, а не рисунок наугад", async () => {
    expect((await createDonationsApi(server([], { stars: { ...STARS, presets: "50,250" }, tribute: null, supporter: false })).view()).ok).toBe(false);
    expect((await createDonationsApi(server([], { stars: { min: 1, presets: [50], mode: "live" }, tribute: null, supporter: false })).view()).ok).toBe(false);
    expect((await createDonationsApi(server([], { stars: { ...STARS, mode: "sandbox" }, tribute: null, supporter: false })).view()).ok).toBe(false);
    expect((await createDonationsApi(server([], { stars: STARS, tribute: null })).view()).ok).toBe(false);
  });
});

describe("заказ доната", () => {
  const INVOICE = { purchaseId: "p-9", sku: "donation", status: "pending", invoiceUrl: "https://t.me/$inv", priceStars: 250, chargedStars: 250, mode: "live" };

  it("order(250) — POST с одной суммой в теле, больше ничего", async () => {
    const sent: Sent[] = [];
    const result = await createDonationsApi(server(sent, INVOICE)).order(250);
    expect(sent).toEqual([{ method: "POST", path: "/api/v1/donations/orders", body: { amount: 250 } }]);
    expect(result.ok && result.data.purchaseId).toBe("p-9");
  });

  it("счёт не по схеме — отказ", async () => {
    expect((await createDonationsApi(server([], { ...INVOICE, status: "weird" })).order(5)).ok).toBe(false);
  });
});

describe("знак «Меценат» в рейтинге", () => {
  const entry = { rank: 1, name: "Дым", photoUrl: null, survivalSec: 100, level: 3, startingWeaponId: "spark", enemiesKilled: 9, isMe: false };
  const board = (entries: unknown[]) => ({ difficultyId: "hard", entries, me: null, totalPlayers: 1 });

  it("признак разбирается; без поля записи знака нет", async () => {
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: leaderboardSchema }).safeParse({ data: board([{ ...entry, supporter: true }, entry]) });
    expect(parsed.success && parsed.data.data.entries.map((row) => row.supporter)).toEqual([true, undefined]);
  });

  it("не `true` — отказ: знак не рисуется по лживому полю", async () => {
    const { z } = await import("zod/mini");
    expect(z.object({ data: leaderboardSchema }).safeParse({ data: board([{ ...entry, supporter: false }]) }).success).toBe(false);
  });
});
