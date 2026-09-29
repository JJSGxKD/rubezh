import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { createFriendsApi, friendInviteUrl } from "../src/state/friends-api";

// Клиент раздела «Друзья» (docs/35-stage4-plan.md §3.8): те пути и методы,
// что ждёт сервер, и ответ, разобранный схемой. Сеть подменяется.

interface Call {
  path: string;
  method: string;
  body?: unknown;
}

function server(calls: Call[], answer: unknown): ApiRequest {
  return async <T,>(path: string, schema: object, init: { method: "GET" | "POST" | "DELETE"; body?: unknown }): Promise<ApiResult<T>> => {
    calls.push({ path, method: init.method, ...(init.body === undefined ? {} : { body: init.body }) });
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
    return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
  };
}

const VIEW = {
  friends: [{ accountId: "f1", displayName: "Дым", photoUrl: null, since: "2026-09-29T10:00:00.000Z", source: "link" }],
  incoming: [{ accountId: "r1", displayName: "Лис", photoUrl: "https://t.me/i/1.jpg", at: "2026-09-30T08:00:00.000Z" }],
  outgoing: [],
  limits: { maxFriends: 100 },
  gifts: { sentToday: ["f1"], pending: 3, claimableToday: 2, coins: 20 },
  bonus: { qualified: 1, steps: [{ friends: 1, coins: 50, state: "ready" }, { friends: 3, coins: 100, state: "locked" }], readyCoins: 50 },
};

describe("клиент раздела «Друзья»", () => {
  it("раздел разбирается схемой целиком", async () => {
    const view = await createFriendsApi(server([], VIEW)).view();
    expect(view.ok && view.data.gifts.claimableToday).toBe(2);
    expect(view.ok && view.data.incoming[0]?.displayName).toBe("Лис");
  });

  it("ответ не по схеме — сбой, а не полупустой экран", async () => {
    expect((await createFriendsApi(server([], { friends: "нет" })).view()).ok).toBe(false);
  });

  it("действия — по путям сервера: заявки, подарок, удаление, забор", async () => {
    const calls: Call[] = [];
    const api = createFriendsApi(server(calls, { sent: true, claimed: 1, coins: 20 }));
    await api.accept("a/1");
    await api.decline("a2");
    await api.cancel("a3");
    await api.gift("a4");
    await api.remove("a5");
    await api.claimGifts();
    await api.claimBonus();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/v1/friends/requests/a%2F1/accept",
      "POST /api/v1/friends/requests/a2/decline",
      "DELETE /api/v1/friends/requests/a3",
      "POST /api/v1/friends/a4/gift",
      "DELETE /api/v1/friends/a5",
      "POST /api/v1/friends/gifts/claim",
      "POST /api/v1/friends/bonus/claim",
    ]);
  });

  it("приглашение — ссылка дружбы в параметре запуска; без бота ссылки нет", () => {
    expect(friendInviteUrl("https://t.me/PlayRubezhBot", "f-abc123")).toBe("https://t.me/PlayRubezhBot?startapp=f-abc123");
    expect(friendInviteUrl("", "f-abc123")).toBe("");
  });
});
