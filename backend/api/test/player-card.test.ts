import { describe, expect, it } from "vitest";
import { PublicIdentity, newPublicId, publicIdSchema, type PublicMark } from "../src/common/public-identity.js";
import { RateLimitedError, ValidationError } from "../src/common/domain-error.js";
import type { Account, AccountRepository } from "../src/modules/auth/account.repository.js";
import type { AccessTokenClaims } from "../src/modules/auth/access-token.js";
import { friendRequestSchema } from "../src/modules/friends/dto/friends.dto.js";
import { PlayersController } from "../src/modules/players/players.controller.js";
import { PlayersService, type PlayerSources } from "../src/modules/players/players.service.js";
import { PlayerNotFoundError } from "../src/modules/players/players-errors.js";
import { CARD_LIMIT, EMBLEM_TOP_LIMIT, isHiddenFrom, relationOf, topEmblems, type CardEmblem } from "../src/modules/players/player-card-rules.js";
import type { RateLimiter } from "../src/modules/ingest/rate-limiter.js";

/**
 * Карточка игрока, сервер (tasks/T-0247, docs/35-stage4-plan.md Р47, Р48): отношение, знаки по
 * редкости, схема публичного id, правило доски и сбор карточки без базы. Запросы и порядок
 * миграции — в `player-card.integration.test.ts`.
 */

const VIEWER = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const PUBLIC = "a1b2c3d4e5f6";
const VIEWER_PUBLIC = "0123456789ab";

describe("публичный id", () => {
  it("схема пускает ровно двенадцать строчных шестнадцатеричных знаков", () => {
    expect(publicIdSchema.safeParse(PUBLIC).success).toBe(true);
    expect(publicIdSchema.safeParse("a1b2c3d4e5f").success).toBe(false); // 11
    expect(publicIdSchema.safeParse("a1b2c3d4e5f67").success).toBe(false); // 13
    expect(publicIdSchema.safeParse("A1B2C3D4E5F6").success).toBe(false); // заглавные
    expect(publicIdSchema.safeParse("g1b2c3d4e5f6").success).toBe(false); // не hex
    expect(publicIdSchema.safeParse("a1b2c3d4e5f\n").success).toBe(false);
    expect(publicIdSchema.safeParse(TARGET).success).toBe(false); // внутренний id не принимается
  });

  it("новый id подходит под схему и не идёт подряд", () => {
    const ids = Array.from({ length: 500 }, () => newPublicId());
    for (const id of ids) expect(publicIdSchema.safeParse(id).success).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    // последовательный счётчик дал бы монотонную строку: у случайного id её нет
    const sorted = [...ids].sort();
    expect(ids.join()).not.toBe(sorted.join());
    // и не совпадает с началом uuid аккаунта: по внутреннему id публичный не угадать
    expect(newPublicId()).not.toBe(newPublicId());
  });
});

describe("отношение к смотрящему", () => {
  const none = { self: false, friends: false, outgoing: false, incoming: false };
  it.each([
    [{ ...none, self: true }, "self"],
    [{ ...none, friends: true }, "friend"],
    [{ ...none, outgoing: true }, "outgoing"],
    [{ ...none, incoming: true }, "incoming"],
    [none, "none"],
  ] as const)("%j → %s", (state, expected) => {
    expect(relationOf(state)).toBe(expected);
  });

  it("свой аккаунт сильнее прочего, дружба сильнее заявок", () => {
    expect(relationOf({ self: true, friends: true, outgoing: true, incoming: true })).toBe("self");
    expect(relationOf({ self: false, friends: true, outgoing: true, incoming: true })).toBe("friend");
  });

  it("встречные заявки не бывают: входящая сильнее исходящей только при гонке, и «входящая» зовёт принять", () => {
    expect(relationOf({ self: false, friends: false, outgoing: true, incoming: true })).toBe("incoming");
  });
});

describe("знаки на карточке по редкости", () => {
  const emblem = (id: string, tier: string): CardEmblem => ({ id, title: id, tier, category: "merit" });

  it("не больше пяти, редкие сверху, «Команда» выше всех", () => {
    const held = [
      emblem("a_common", "common"),
      emblem("b_mythic", "mythic"),
      emblem("c_rare", "rare"),
      emblem("d_team", "team"),
      emblem("e_epic", "epic"),
      emblem("f_legendary", "legendary"),
      emblem("g_uncommon", "uncommon"),
    ];
    const top = topEmblems(held);
    expect(top).toHaveLength(EMBLEM_TOP_LIMIT);
    expect(top.map((item) => item.id)).toEqual(["d_team", "b_mythic", "f_legendary", "e_epic", "c_rare"]);
  });

  it("при равной редкости порядок один и тот же: по id", () => {
    const held = [emblem("z", "rare"), emblem("a", "rare"), emblem("m", "rare")];
    expect(topEmblems(held).map((item) => item.id)).toEqual(["a", "m", "z"]);
    expect(topEmblems([...held].reverse()).map((item) => item.id)).toEqual(["a", "m", "z"]);
  });

  it("меньше пяти и пусто — как есть; неизвестная редкость ниже всех", () => {
    expect(topEmblems([])).toEqual([]);
    expect(topEmblems([emblem("x", "weird"), emblem("y", "common")]).map((item) => item.id)).toEqual(["y", "x"]);
  });

  it("исходный список не меняется", () => {
    const held = [emblem("b", "common"), emblem("a", "mythic")];
    topEmblems(held);
    expect(held.map((item) => item.id)).toEqual(["b", "a"]);
  });
});

describe("правило доски", () => {
  it("игрок отдельной доски скрыт только от тех, кто читает общую", () => {
    expect(isHiddenFrom("common", "full")).toBe(true);
    expect(isHiddenFrom("full", "full")).toBe(false);
    expect(isHiddenFrom("full", "common")).toBe(false);
    expect(isHiddenFrom("common", "common")).toBe(false);
  });
});

describe("тело заявки в друзья", () => {
  it("ровно одно из двух: accountId или publicId", () => {
    expect(friendRequestSchema.safeParse({ accountId: TARGET }).success).toBe(true);
    expect(friendRequestSchema.safeParse({ publicId: PUBLIC }).success).toBe(true);
    expect(friendRequestSchema.safeParse({ accountId: TARGET, publicId: PUBLIC }).success).toBe(false);
    expect(friendRequestSchema.safeParse({}).success).toBe(false);
    expect(friendRequestSchema.safeParse({ publicId: "A1B2C3D4E5F6" }).success).toBe(false);
    expect(friendRequestSchema.safeParse({ publicId: PUBLIC.slice(1) }).success).toBe(false);
    expect(friendRequestSchema.safeParse({ publicId: null }).success).toBe(false);
  });
});

describe("порт меток", () => {
  it("публичный id идёт в метке и чистится; чужое поле источника наружу не уходит", async () => {
    const identity = new PublicIdentity();
    identity.provide({ of: async () => new Map<string, PublicMark>([[TARGET, { publicId: PUBLIC, accountId: "утечка" } as PublicMark]]) }, "publicId");
    const marks = await identity.of([TARGET]);
    expect(marks.get(TARGET)).toEqual({ publicId: PUBLIC });
  });

  it("битый публичный id источника отбрасывается, облик из той же записи остаётся", async () => {
    const identity = new PublicIdentity();
    identity.provide({ of: async () => new Map<string, PublicMark>([[TARGET, { publicId: "ЗАГЛАВНЫЕ", appearance: "vityaz" }]]) }, "appearance");
    expect((await identity.of([TARGET])).get(TARGET)).toEqual({ appearance: "vityaz" });
  });

  it("сбой источника публичного id не стирает метки соседнего", async () => {
    const identity = new PublicIdentity();
    identity.provide({ of: async () => new Map<string, PublicMark>([[TARGET, { appearance: "vityaz" }]]) }, "appearance");
    identity.provide({ of: async () => Promise.reject(new Error("база недоступна")) }, "publicId");
    expect((await identity.of([TARGET])).get(TARGET)).toEqual({ appearance: "vityaz" });
  });
});

// --- сбор карточки -----------------------------------------------------------------------

interface Setup {
  accounts: Map<string, Account>;
  boards: Map<string, "full" | "common">;
  friends: Set<string>;
  requests: Set<string>;
  fail: Set<string>;
  calls: string[];
  service: PlayersService;
}

function account(accountId: string, publicId: string, patch: Partial<Account> = {}): Account {
  return {
    accountId,
    publicId,
    platform: "telegram",
    platformUserId: accountId === VIEWER ? "100500" : "777000",
    displayName: accountId === VIEWER ? "Смотрящий" : "Стрелок",
    username: null,
    photoUrl: "https://example.com/p.png",
    createdAt: new Date("2026-10-01T00:00:00Z"),
    bannedAt: null,
    banReason: null,
    created: false,
    ...patch,
  };
}

function setup(): Setup {
  const accounts = new Map<string, Account>([
    [VIEWER, account(VIEWER, VIEWER_PUBLIC)],
    [TARGET, account(TARGET, PUBLIC)],
  ]);
  const boards = new Map<string, "full" | "common">();
  const friends = new Set<string>();
  const requests = new Set<string>();
  const fail = new Set<string>();
  const calls: string[] = [];
  const guard = async <T>(name: string, value: T): Promise<T> => {
    calls.push(name);
    if (fail.has(name)) throw new Error(`${name}: сбой`);
    return value;
  };
  const identity = new PublicIdentity();
  identity.provide({ of: async (ids) => new Map(ids.map((id) => [id, { appearance: "vityaz", avatarPhoto: true as const, emblem: { id: "emb_vip", title: "VIP", tier: "legendary", category: "status" as const } }])) }, "appearance");

  const sources: PlayerSources = {
    accounts: {
      byPublicId: async (id: string) => [...accounts.values()].find((item) => item.publicId === id) ?? null,
    } as unknown as AccountRepository,
    friends: {
      areFriends: async (a: string, b: string) => friends.has([a, b].sort().join(":")),
      hasRequest: async (from: string, to: string) => requests.has(`${from}>${to}`),
    },
    rating: { boardOf: async (id: string) => boards.get(id) ?? "common" },
    runs: { cardStats: async (target: string, viewer: string) => guard("runs", { runs: 12, totalKills: 3400, bestSurvivalSec: 640, target, viewer }).then(({ runs, totalKills, bestSurvivalSec }) => ({ runs, totalKills, bestSurvivalSec })) },
    seasons: { placeOf: async () => guard("season", 7) },
    progress: { view: async () => guard("level", { level: 14 }) },
    items: { powerOf: async () => guard("power", 1830) },
    achievements: {
      summary: async () =>
        guard("achievements", { prestige: 55, favorites: [{ id: "ach_elite_50", title: "Гроза элит", category: "combat" as const }] }),
    },
    emblems: {
      heldList: async () =>
        guard("emblems", [
          { id: "emb_vip", title: "VIP", tier: "legendary", category: "status" as const },
          { id: "emb_tester", title: "Тестер", tier: "rare", category: "status" as const },
        ]),
    },
    vip: { activeAt: async () => guard("vip", true) },
    identity,
  };
  return { accounts, boards, friends, requests, fail, calls, service: new PlayersService(sources) };
}

describe("карточка игрока", () => {
  it("собирает все блоки по спецификации", async () => {
    const { service } = setup();
    const card = await service.card(VIEWER, PUBLIC);
    expect(card).toEqual({
      publicId: PUBLIC,
      name: "Стрелок",
      photoUrl: "https://example.com/p.png",
      appearance: "vityaz",
      avatarPhoto: true,
      emblem: { id: "emb_vip", title: "VIP", tier: "legendary", category: "status" },
      emblems: {
        held: 2,
        top: [
          { id: "emb_vip", title: "VIP", tier: "legendary", category: "status" },
          { id: "emb_tester", title: "Тестер", tier: "rare", category: "status" },
        ],
      },
      level: 14,
      power: 1830,
      season: { place: 7 },
      stats: { runs: 12, totalKills: 3400, bestSurvivalSec: 640 },
      prestige: 55,
      favorites: [{ id: "ach_elite_50", title: "Гроза элит", category: "combat" }],
      relation: "none",
      vip: true,
    });
  });

  it("внутренний id и id площадки в ответе не встречаются", async () => {
    const { service } = setup();
    const text = JSON.stringify(await service.card(VIEWER, PUBLIC));
    expect(text).not.toContain(TARGET);
    expect(text).not.toContain("accountId");
    expect(text).not.toContain("777000");
    expect(text).not.toContain("platformUserId");
  });

  it("отношение: друг, исходящая, входящая, своя", async () => {
    const s = setup();
    s.friends.add([VIEWER, TARGET].sort().join(":"));
    expect((await s.service.card(VIEWER, PUBLIC)).relation).toBe("friend");
    s.friends.clear();
    s.requests.add(`${VIEWER}>${TARGET}`);
    expect((await s.service.card(VIEWER, PUBLIC)).relation).toBe("outgoing");
    s.requests.clear();
    s.requests.add(`${TARGET}>${VIEWER}`);
    expect((await s.service.card(VIEWER, PUBLIC)).relation).toBe("incoming");
    expect((await s.service.card(VIEWER, VIEWER_PUBLIC)).relation).toBe("self");
  });

  it("нет такого публичного id — player_not_found 404", async () => {
    const { service } = setup();
    await expect(service.card(VIEWER, "ffffffffffff")).rejects.toBeInstanceOf(PlayerNotFoundError);
    await expect(service.card(VIEWER, "ffffffffffff")).rejects.toMatchObject({ code: "player_not_found", status: 404 });
  });

  it("заблокированный — как несуществующий", async () => {
    const s = setup();
    s.accounts.set(TARGET, account(TARGET, PUBLIC, { bannedAt: new Date() }));
    await expect(s.service.card(VIEWER, PUBLIC)).rejects.toMatchObject({ code: "player_not_found" });
  });

  it("игрок отдельной доски скрыт от общей доски — тем же 404; полной доске виден", async () => {
    const s = setup();
    s.boards.set(TARGET, "full");
    await expect(s.service.card(VIEWER, PUBLIC)).rejects.toMatchObject({ code: "player_not_found", status: 404 });
    // ни одного блока не собиралось: скрытый не должен отличаться от несуществующего и по тому, что читается
    expect(s.calls).toEqual([]);
    s.boards.set(VIEWER, "full");
    expect((await s.service.card(VIEWER, PUBLIC)).publicId).toBe(PUBLIC);
  });

  it("себя игрок видит всегда, даже на отдельной доске", async () => {
    const s = setup();
    s.boards.set(VIEWER, "full");
    expect((await s.service.card(VIEWER, VIEWER_PUBLIC)).relation).toBe("self");
  });

  it("сбой знаков и витрины — блоки пустые, карточка отдаётся", async () => {
    const s = setup();
    s.fail.add("emblems");
    s.fail.add("achievements");
    const card = await s.service.card(VIEWER, PUBLIC);
    expect(card.emblems).toEqual({ held: 0, top: [] });
    expect(card.prestige).toBe(0);
    expect(card.favorites).toEqual([]);
    expect(card.level).toBe(14);
  });

  it("сбой места в сезоне и VIP — `season: null`, без `vip`", async () => {
    const s = setup();
    s.fail.add("season");
    s.fail.add("vip");
    const card = await s.service.card(VIEWER, PUBLIC);
    expect(card.season).toBeNull();
    expect(card).not.toHaveProperty("vip");
  });

  it("VIP не активен — поля `vip` нет; нет фото — поля `photoUrl` и `avatarPhoto` нет", async () => {
    const s = setup();
    s.accounts.set(TARGET, account(TARGET, PUBLIC, { photoUrl: null }));
    const sources = (s.service as unknown as { sources: PlayerSources }).sources;
    sources.vip = { activeAt: async () => false };
    sources.identity = new PublicIdentity();
    const card = await s.service.card(VIEWER, PUBLIC);
    expect(card).not.toHaveProperty("vip");
    expect(card).not.toHaveProperty("photoUrl");
    expect(card).not.toHaveProperty("avatarPhoto");
    // источник обликов недоступен — Хранитель
    expect(card.appearance).toBe("keeper");
    expect(card).not.toHaveProperty("emblem");
  });

  it("числа читаются по доске смотрящего: сервис передаёт источникам обоих", async () => {
    const s = setup();
    const seen: string[][] = [];
    const sources = (s.service as unknown as { sources: PlayerSources }).sources;
    sources.runs = { cardStats: async (target, viewer) => (seen.push([target, viewer]), { runs: 1, totalKills: 1, bestSurvivalSec: 1 }) };
    sources.seasons = { placeOf: async (target, viewer) => (seen.push([target, viewer]), null) };
    await s.service.card(VIEWER, PUBLIC);
    expect(seen).toEqual([
      [TARGET, VIEWER],
      [TARGET, VIEWER],
    ]);
  });
});

// --- ручка -------------------------------------------------------------------------------

describe("ручка карточки", () => {
  const claims = { accountId: VIEWER, platform: "telegram" } as unknown as AccessTokenClaims;
  const request = { account: claims };

  function controller(allowed: () => boolean): { controller: PlayersController; asked: string[] } {
    const asked: string[] = [];
    const service = { card: async (_viewer: string, publicId: string) => (asked.push(publicId), { publicId }) } as unknown as PlayersService;
    const limiter = { consume: async () => allowed() } as unknown as RateLimiter;
    return { controller: new PlayersController(service, limiter), asked };
  }

  it("лимит — 60 карточек в минуту на смотрящего", () => {
    expect(CARD_LIMIT).toMatchObject({ limit: 60, windowSec: 60 });
  });

  it("плохой публичный id — 400, до сервиса и до лимита дело не доходит", async () => {
    const { controller: ctl, asked } = controller(() => true);
    for (const bad of ["A1B2C3D4E5F6", "a1b2c3d4e5f", "a1b2c3d4e5f67", TARGET, "../etc/passwd"]) {
      await expect(ctl.card(request, bad)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(asked).toEqual([]);
  });

  it("лимит исчерпан — 429, сервис не зовётся", async () => {
    const { controller: ctl, asked } = controller(() => false);
    await expect(ctl.card(request, PUBLIC)).rejects.toBeInstanceOf(RateLimitedError);
    expect(asked).toEqual([]);
  });

  it("в пределах лимита — ответ в обёртке data", async () => {
    const { controller: ctl } = controller(() => true);
    expect(await ctl.card(request, PUBLIC)).toEqual({ data: { publicId: PUBLIC } });
  });
});
