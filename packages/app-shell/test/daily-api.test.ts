import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { createBadgesApi, loadBadges } from "../src/state/badges-api";
import { useBadges } from "../src/state/badges";
import { createDailyApi, dayOfWeek } from "../src/state/daily-api";

// Клиент награды дня (docs/35-stage4-plan.md WP13): неделя и забор — с
// сервера, схемой; знак награды на главной — из знаков меню, и сервер старее
// клиента без этого поля знак просто не зажигает.

function server(paths: string[], answer: unknown): ApiRequest {
  return async <T,>(path: string, schema: object, init?: { method?: string }): Promise<ApiResult<T>> => {
    paths.push(`${init?.method ?? "GET"} ${path}`);
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
    return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
  };
}

const VIEW = {
  week: 2,
  days: Array.from({ length: 7 }, (_, index) => ({ day: 8 + index, coins: 69 + index, shards: index === 6 ? 12 : 0, claimed: index < 2, today: index === 2 })),
  canClaim: true,
  step: 1.15,
  nextStep: 1.3,
};

describe("клиент награды дня", () => {
  it("неделя — GET, забор — POST без тела; ответ разбирается схемой", async () => {
    const paths: string[] = [];
    const api = createDailyApi(server(paths, VIEW));
    const view = await api.view();
    expect(view.ok && view.data.days).toHaveLength(7);

    const claim = await createDailyApi(server(paths, { claimed: true, coins: 71, shards: 0, view: VIEW })).claim();
    expect(claim.ok && claim.data.coins).toBe(71);
    expect(paths).toEqual(["GET /api/v1/daily", "POST /api/v1/daily/claim"]);
  });

  it("день недели для подписи и события — по месту в неделе, а не по номеру дня", async () => {
    const today = VIEW.days[2];
    if (today === undefined) throw new Error("нет дня");
    expect(dayOfWeek(today, VIEW.days)).toBe(3);
  });

  it("знаки меню от сервера без награды дня и журнала — знаки не горят, остальное принято", async () => {
    await loadBadges(createBadgesApi(server([], { arsenal: 1, friends: 2, notifications: 3 })));
    expect(useBadges.getState()).toEqual({ arsenal: 1, friends: 2, notifications: 3, daily: 0, changelog: 0 });

    await loadBadges(createBadgesApi(server([], { arsenal: 0, friends: 0, notifications: 0, daily: 1, changelog: 2 })));
    expect(useBadges.getState()).toMatchObject({ daily: 1, changelog: 2 });
  });
});
