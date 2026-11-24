import { describe, expect, it } from "vitest";
import type { ApiFailure, ApiRequest, ApiResult } from "../src/state/api-request";
import { createFriendsApi } from "../src/state/friends-api";
import { createPlayerCardApi } from "../src/state/player-card-api";
import { leaderboardSchema } from "../src/state/runs-api";

// Клиент карточки игрока (tasks/T-0248, tasks/T-0247): ответ сервера — граница
// системы и разбирается схемой; коды отказа доходят до экрана причиной, а не
// строкой; игрока называют публичным id, внутреннего id в запросах нет.

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

type Init = { method: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown };

function server(sent: Sent[], answer: unknown): ApiRequest {
  return async <T,>(path: string, schema: object, init: Init): Promise<ApiResult<T>> => {
    sent.push({ method: init.method, path, body: init.body });
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
    return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
  };
}

function failing(sent: Sent[], failure: ApiFailure, code?: string): ApiRequest {
  return async <T,>(path: string, _schema: object, init: Init): Promise<ApiResult<T>> => {
    sent.push({ method: init.method, path, body: init.body });
    return { ok: false, failure, ...(code === undefined ? {} : { code }) };
  };
}

const ID = "0a1b2c3d4e5f";
const EMBLEM = { id: "emb_champion", title: "Чемпион", tier: "mythic", category: "season" as const, season: 3 };
const FULL = {
  publicId: ID,
  name: "Велимир",
  photoUrl: "https://t.me/i/userpic/1.jpg",
  appearance: "navi",
  avatarPhoto: true,
  emblem: EMBLEM,
  emblems: { held: 12, top: [EMBLEM, { id: "emb_tester", title: "Тестер", tier: "rare", category: "status" }] },
  level: 41,
  power: 1_830,
  season: { place: 3 },
  stats: { runs: 214, totalKills: 9_000, bestSurvivalSec: 760 },
  prestige: 120,
  favorites: [{ id: "ach_boss", title: "Гроза боссов", category: "boss" }],
  relation: "none",
  vip: true,
};
const MINIMAL = {
  publicId: ID,
  name: "Лис",
  appearance: "keeper",
  emblems: { held: 0, top: [] },
  level: 1,
  power: 0,
  season: null,
  stats: { runs: 0, totalKills: 0, bestSurvivalSec: 0 },
  prestige: 0,
  favorites: [],
  relation: "self",
};

describe("карточка игрока: загрузка", () => {
  it("полный ответ разбирается; запрос — GET по публичному id без тела", async () => {
    const sent: Sent[] = [];

    const answer = await createPlayerCardApi(server(sent, FULL)).load(ID);

    expect(sent).toEqual([{ method: "GET", path: `/api/v1/players/${ID}`, body: undefined }]);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.data.name).toBe("Велимир");
    expect(answer.data.season).toEqual({ place: 3 });
    expect(answer.data.emblems.top.map((emblem) => emblem.id)).toEqual(["emb_champion", "emb_tester"]);
    expect(answer.data.favorites[0]?.title).toBe("Гроза боссов");
    expect(answer.data.vip).toBe(true);
  });

  it("ответ без необязательных блоков (фото, знак, VIP, облик-фото) разбирается", async () => {
    const answer = await createPlayerCardApi(server([], MINIMAL)).load(ID);

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.data.photoUrl).toBeUndefined();
    expect(answer.data.emblem).toBeUndefined();
    expect(answer.data.vip).toBeUndefined();
    expect(answer.data.season).toBeNull();
  });

  it("незнакомое отношение и витринное достижение без названия не роняют карточку: сервер новее клиента", async () => {
    const answer = await createPlayerCardApi(server([], { ...FULL, relation: "blocked", favorites: [{ id: "ach_new", title: null, category: "future" }] })).load(ID);

    expect(answer.ok).toBe(true);
  });

  it("битый ответ — отказ, а не молча пустая карточка", async () => {
    const noStats = await createPlayerCardApi(server([], { ...FULL, stats: undefined })).load(ID);
    const badLevel = await createPlayerCardApi(server([], { ...FULL, level: "41" })).load(ID);

    expect(noStats).toEqual({ ok: false, reason: "unavailable" });
    expect(badLevel).toEqual({ ok: false, reason: "unavailable" });
  });

  it("чужая строка вместо публичного id до сети не доходит: «не найден»", async () => {
    const sent: Sent[] = [];

    const answer = await createPlayerCardApi(server(sent, FULL)).load("../friends");

    expect(answer).toEqual({ ok: false, reason: "not_found" });
    expect(sent).toEqual([]);
  });
});

describe("карточка игрока: отказы", () => {
  it("404 с кодом player_not_found — «не найден»", async () => {
    const answer = await createPlayerCardApi(failing([], "disabled", "player_not_found")).load(ID);

    expect(answer).toEqual({ ok: false, reason: "not_found" });
  });

  it("429 с кодом rate_limited — «слишком часто»", async () => {
    const answer = await createPlayerCardApi(failing([], "unavailable", "rate_limited")).load(ID);

    expect(answer).toEqual({ ok: false, reason: "too_often" });
  });

  it("404 без кода (шлюз, сервер без карточек) — не «игрок не найден», а общий отказ", async () => {
    const answer = await createPlayerCardApi(failing([], "disabled")).load(ID);

    expect(answer).toEqual({ ok: false, reason: "disabled" });
  });

  it("нет сети, сброшенный вход, нет входа — причина запроса как есть", async () => {
    expect(await createPlayerCardApi(failing([], "offline")).load(ID)).toEqual({ ok: false, reason: "offline" });
    expect(await createPlayerCardApi(failing([], "unauthorized")).load(ID)).toEqual({ ok: false, reason: "unauthorized" });
    expect(await createPlayerCardApi(failing([], "no_identity")).load(ID)).toEqual({ ok: false, reason: "no_identity" });
    expect(await createPlayerCardApi(failing([], "unavailable")).load(ID)).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("заявка в друзья по публичному id", () => {
  it("POST /friends/requests с телом {publicId}: внутреннего id в запросе нет", async () => {
    const sent: Sent[] = [];

    const answer = await createFriendsApi(server(sent, { status: "requested" })).request(ID);

    expect(sent).toEqual([{ method: "POST", path: "/api/v1/friends/requests", body: { publicId: ID } }]);
    expect(answer.ok && answer.data.status).toBe("requested");
  });

  it("встречная заявка принимается тем же запросом: ответ «friends»", async () => {
    const answer = await createFriendsApi(server([], { status: "friends" })).request(ID);

    expect(answer.ok && answer.data.status).toBe("friends");
  });

  it("отказы сервера доходят с кодом: себе — validation_failed, потолок — friend_limit", async () => {
    expect(await createFriendsApi(failing([], "rejected", "validation_failed")).request(ID)).toEqual({ ok: false, failure: "rejected", code: "validation_failed" });
    expect(await createFriendsApi(failing([], "unavailable", "friend_limit")).request(ID)).toEqual({ ok: false, failure: "unavailable", code: "friend_limit" });
  });
});

describe("публичный id в строках списков", () => {
  const ROW = {
    rank: 1,
    name: "Велимир",
    photoUrl: null,
    survivalSec: 760,
    level: 41,
    startingWeaponId: "bolt",
    enemiesKilled: 900,
    isMe: false,
  };
  const board = (entry: object): unknown => ({ difficultyId: "hard", entries: [entry], me: null, totalPlayers: 1 });

  it("строка рейтинга и сезона с publicId разбирается и несёт его", () => {
    const parsed = leaderboardSchema.safeParse(board({ ...ROW, publicId: ID }));

    expect(parsed.success && parsed.data.entries[0]?.publicId).toBe(ID);
  });

  it("строка без publicId (старый сервер) разбирается, поля нет", () => {
    const parsed = leaderboardSchema.safeParse(board(ROW));

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.entries[0]?.publicId).toBeUndefined();
  });

  it("друг и заявка с publicId разбираются; без него — как раньше", async () => {
    const peer = { accountId: "f1", displayName: "Дым", photoUrl: null };
    const view = {
      friends: [{ ...peer, publicId: ID, since: "2026-09-29T10:00:00.000Z", source: "link" }],
      incoming: [{ ...peer, at: "2026-09-30T08:00:00.000Z" }],
      outgoing: [],
      limits: { maxFriends: 100 },
      gifts: { sentToday: [], pending: 0, claimableToday: 0, coins: 20 },
      bonus: { qualified: 0, steps: [], readyCoins: 0 },
    };

    const answer = await createFriendsApi(server([], view)).view();

    expect(answer.ok && answer.data.friends[0]?.publicId).toBe(ID);
    expect(answer.ok && answer.data.incoming[0]?.publicId).toBeUndefined();
  });
});
