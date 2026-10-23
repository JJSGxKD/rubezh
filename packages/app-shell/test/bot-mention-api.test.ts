import { describe, expect, it } from "vitest";
import { EVENT_DICTIONARY } from "../../../backend/api/src/modules/events/event-dictionary.js";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { createBotMentionApi } from "../src/state/bot-mention-api";
import { ANALYTICS_EVENTS } from "../src/state/analytics";

// Клиент заданий «юзернейм бота» (tasks/T-0160): запросы — по описанию T-0162,
// ответ разбирается схемой, незнакомое от сервера новее клиента — не падение.

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

const REWARD = { coins: 50, gems: 0, shards: 0 };
const TASK = { kind: "name", reward: REWARD, started: true, streak: 3, bestStreak: 5, rewardedToday: false, lastResult: "absent", checkedAt: "2026-10-23T10:00:00.000Z" };
const VIEW = { botUsername: "game_bot", tasks: [TASK] };

describe("клиент заданий «юзернейм бота»", () => {
  it("view — GET /api/v1/bot-mention; незнакомый вид и лишнее поле разбираются, не падая", async () => {
    const sent: Sent[] = [];
    const answer = { ...VIEW, extra: 1, tasks: [TASK, { ...TASK, kind: "future_kind", extra: true }] };
    const response = await createBotMentionApi(server(sent, answer)).view();

    expect(sent).toEqual([{ method: "GET", path: "/api/v1/bot-mention", body: undefined }]);
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data.botUsername).toBe("game_bot");
      expect(response.data.tasks.map((task) => task.kind)).toEqual(["name", "future_kind"]);
    }
  });

  it("у площадки без заданий botUsername — null", async () => {
    const response = await createBotMentionApi(server([], { botUsername: null, tasks: [] })).view();
    expect(response.ok && response.data.botUsername).toBeNull();
  });

  it("check — POST /api/v1/bot-mention/<вид>/check без тела", async () => {
    const sent: Sent[] = [];
    const answer = { outcome: "present", credited: REWARD, view: VIEW };
    const response = await createBotMentionApi(server(sent, answer)).check("name");

    expect(sent).toEqual([{ method: "POST", path: "/api/v1/bot-mention/name/check", body: undefined }]);
    expect(response.ok && response.data.credited).toEqual(REWARD);
  });

  it("слэш в виде кодируется в пути", async () => {
    const sent: Sent[] = [];
    await createBotMentionApi(server(sent, { outcome: "absent", credited: { coins: 0, gems: 0, shards: 0 }, view: VIEW })).check("a/b");
    expect(sent[0]?.path).toBe("/api/v1/bot-mention/a%2Fb/check");
  });

  it("исход незнакомой строкой разбирается: сервер новее клиента", async () => {
    const response = await createBotMentionApi(server([], { outcome: "something_new", credited: { coins: 0, gems: 0, shards: 0 }, view: VIEW })).check("bio");
    expect(response.ok && response.data.outcome).toBe("something_new");
  });

  it("ответ не того вида — отказ, а не исключение", async () => {
    const response = await createBotMentionApi(server([], { nonsense: true })).view();
    expect(response.ok).toBe(false);
  });
});

describe("события заданий «юзернейм бота»", () => {
  it("клиент знает оба, словарь сервера принимает полный набор полей", () => {
    expect(ANALYTICS_EVENTS).toContain("bot_mention_started");
    expect(ANALYTICS_EVENTS).toContain("bot_mention_checked");
    expect(EVENT_DICTIONARY.bot_mention_started.payload.safeParse({ kind: "name" }).success).toBe(true);
    expect(EVENT_DICTIONARY.bot_mention_checked.payload.safeParse({ kind: "bio", outcome: "hidden" }).success).toBe(true);
  });

  it("чужой вид и чужой исход схема не принимает; обязательные поля — обязательны", () => {
    expect(EVENT_DICTIONARY.bot_mention_started.payload.safeParse({ kind: "other" }).success).toBe(false);
    expect(EVENT_DICTIONARY.bot_mention_started.payload.safeParse({}).success).toBe(false);
    expect(EVENT_DICTIONARY.bot_mention_checked.payload.safeParse({ kind: "name", outcome: "weird" }).success).toBe(false);
    expect(EVENT_DICTIONARY.bot_mention_checked.payload.safeParse({ kind: "name" }).success).toBe(false);
  });

  it("исходы схемы — ровно шесть из T-0162", () => {
    for (const outcome of ["present", "absent", "hidden", "unavailable", "retry", "done_today"]) {
      expect(EVENT_DICTIONARY.bot_mention_checked.payload.safeParse({ kind: "name", outcome }).success, outcome).toBe(true);
    }
  });
});
