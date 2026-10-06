import { beforeEach, describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { useBadges } from "../src/state/badges";
import { createHomeApi, forgetHomeForTests, HOME_FRESH_MS, refreshHome, useHome, type DailyWidget, type HomeApi, type HomeData, type WheelWidget } from "../src/state/home-api";

// Ответ главной (docs/35-stage4-plan.md WP42): слайды и виджеты одним
// запросом, каждый виджет разбирается сам. Ответ общий у карусели и виджетов
// и устаревает через минуту или сразу, как обновились знаки меню: забег,
// забор награды, возврат в приложение меняют то, что на главной.

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const DAYS = [60, 80, 100, 120, 150, 180, 300].map((coins, index) => ({ coins, shards: index === 6 ? 10 : 0, claimed: index < 2, today: index === 2 }));
const DAILY: DailyWidget = { canClaim: true, days: DAYS, next: { coins: 120, shards: 0 } };
const WHEEL: WheelWidget = { free: false, jackpot: 1_000, ad: { available: true, readyAt: null, vip: false } };

function server(answer: unknown): ApiRequest {
  return async <T,>(_path: string, schema: object): Promise<ApiResult<T>> => {
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
    return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
  };
}

describe("виджеты в ответе главной", () => {
  it("каждый разбирается сам: битый — без подробностей, соседи на месте", async () => {
    const answer = { slides: [], widgets: { daily: DAILY, wheel: { ...WHEEL, jackpot: "много" }, tasks: { dailyDone: 1, dailyTotal: 4, claimable: 0 } } };
    const result = await createHomeApi(server(answer)).home();
    expect(result.ok && result.data.widgets).toEqual({ daily: DAILY, wheel: null, tasks: { dailyDone: 1, dailyTotal: 4, claimable: 0 } });
  });

  it("сервер старее клиента, без виджетов, — карусель есть, виджеты без подробностей", async () => {
    const result = await createHomeApi(server({ slides: [{ id: "invite", kind: "invite" }] })).home();
    expect(result.ok && result.data).toEqual({ slides: [{ id: "invite", kind: "invite" }], widgets: { daily: null, wheel: null, tasks: null } });
  });
});

describe("свежесть ответа главной", () => {
  const DATA: HomeData = { slides: [], widgets: { daily: null, wheel: null, tasks: null } };

  function counting(results: ApiResult<HomeData>[] = []): HomeApi & { asked: number } {
    const api = {
      asked: 0,
      async home(): Promise<ApiResult<HomeData>> {
        api.asked += 1;
        return results.shift() ?? { ok: true, data: DATA };
      },
    };
    return api;
  }

  beforeEach(() => {
    forgetHomeForTests();
    useBadges.setState({ loadedAt: 0 });
  });

  it("свежий — минуту и пока не обновились знаки меню; два слота разом — один запрос", async () => {
    const api = counting();
    await Promise.all([refreshHome(api, NOW), refreshHome(api, NOW)]);
    expect(api.asked).toBe(1);
    await refreshHome(api, NOW + HOME_FRESH_MS - 1);
    expect(api.asked).toBe(1);
    await refreshHome(api, NOW + HOME_FRESH_MS);
    expect(api.asked).toBe(2);
  });

  it("знаки меню обновились — забег, забор, возврат в приложение — ответ устарел сразу", async () => {
    const api = counting();
    await refreshHome(api, NOW);
    useBadges.setState({ loadedAt: NOW + 1_000 });
    await refreshHome(api, NOW + 2_000);
    expect(api.asked).toBe(2);
    await refreshHome(api, NOW + 3_000);
    expect(api.asked).toBe(2);
  });

  it("сбой без прежнего ответа — карусели нет; с прежним — он остаётся на экране", async () => {
    await refreshHome(counting([{ ok: false, failure: "offline" }]), NOW);
    expect(useHome.getState()).toMatchObject({ data: null, failed: true });

    forgetHomeForTests();
    await refreshHome(counting(), NOW);
    await refreshHome(counting([{ ok: false, failure: "offline" }]), NOW + HOME_FRESH_MS);
    expect(useHome.getState()).toMatchObject({ data: DATA, failed: false });
  });
});
