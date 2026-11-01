import { describe, expect, it } from "vitest";
import ru from "../src/i18n/ru.json";
import ruTasks from "../src/i18n/ru-tasks.json";
import { createAchievementsApi, favoriteFailureKey, isOpenAchievement, ACHIEVEMENT_NOT_UNLOCKED } from "../src/state/achievements-api";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { createRunsApi } from "../src/state/runs-api";

// Клиент витрины достижений (tasks/T-0107): ответ сервера — граница системы и
// разбирается схемой. Закрытое скрытое достижение приходит без названия, цели и
// награды; редкость, подсказка и фильтр могут отсутствовать (старый сервер,
// население ниже порога).

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

const OPEN = {
  id: "ach_kills_1",
  category: "combat",
  ladder: "kills",
  rung: 1,
  hidden: false,
  kind: "kills",
  filter: null,
  title: "Первая сотня",
  hint: null,
  target: 100,
  value: 40,
  done: false,
  claimed: false,
  reward: { coins: 100, gems: 0, shards: 0 },
  prestige: 5,
  percent: 12.3,
};

const CLOSED = { id: "ach_secret", category: "mastery", hidden: true, done: false, hint: "Не всё на виду" };

const RARITY = { population: 120, shown: true, computedAt: "2026-10-20T10:00:00.000Z" };

describe("клиент витрины достижений", () => {
  it("полный ответ разбирается: открытое с процентом и закрытое скрытое с одной подсказкой", async () => {
    const sent: Sent[] = [];
    const response = await createAchievementsApi(server(sent, { prestige: 15, favorites: ["ach_kills_1"], rarity: RARITY, items: [OPEN, CLOSED] })).load();

    expect(sent).toEqual([{ method: "GET", path: "/api/v1/achievements", body: undefined }]);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.prestige).toBe(15);
    expect(response.data.favorites).toEqual(["ach_kills_1"]);
    const [first, second] = response.data.items;
    expect(first && isOpenAchievement(first)).toBe(true);
    expect(first).toMatchObject({ id: "ach_kills_1", percent: 12.3, ladder: "kills", rung: 1 });
    expect(second && isOpenAchievement(second)).toBe(false);
    expect(second).toMatchObject({ id: "ach_secret", hidden: true, done: false, hint: "Не всё на виду" });
  });

  it("процент `null` разбирается — население ниже порога", async () => {
    const response = await createAchievementsApi(server([], { prestige: 0, favorites: [], rarity: { population: 0, shown: false, computedAt: null }, items: [{ ...OPEN, percent: null }] })).load();

    expect(response.ok && response.data.items[0]).toMatchObject({ percent: null });
  });

  it("ответ без необязательных полей не падает: ни процента, ни подсказки, ни фильтра", async () => {
    const { percent: _percent, hint: _hint, filter: _filter, ...bare } = OPEN;

    const response = await createAchievementsApi(server([], { prestige: 0, favorites: [], rarity: RARITY, items: [bare] })).load();

    expect(response.ok).toBe(true);
    const item = response.ok ? response.data.items[0] : undefined;
    expect(item && isOpenAchievement(item) ? item.percent ?? null : "нет").toBeNull();
  });

  it("незнакомый вид цели и категория не роняют витрину: сервер новее клиента", async () => {
    const response = await createAchievementsApi(server([], { prestige: 0, favorites: [], rarity: RARITY, items: [{ ...OPEN, kind: "elites", category: "seasons" }] })).load();

    expect(response.ok).toBe(true);
  });

  it("битый ответ — отказ схемы, а не молча пустая витрина", async () => {
    const broken = await createAchievementsApi(server([], { prestige: "много", favorites: [], rarity: RARITY, items: [] })).load();
    const noItems = await createAchievementsApi(server([], { prestige: 0, favorites: [], rarity: RARITY })).load();

    expect(broken.ok).toBe(false);
    expect(noItems.ok).toBe(false);
  });

  it("сводка для профиля: престиж и любимые с названием и категорией", async () => {
    const sent: Sent[] = [];
    const response = await createAchievementsApi(
      server(sent, { prestige: 20, favorites: [{ id: "ach_kills_1", title: "Первая сотня", category: "combat" }, { id: "ach_x", title: null, category: "mastery" }] }),
    ).summary();

    expect(sent).toEqual([{ method: "GET", path: "/api/v1/achievements/summary", body: undefined }]);
    expect(response.ok && response.data.favorites.map((item) => item.id)).toEqual(["ach_kills_1", "ach_x"]);
    expect(response.ok && response.data.prestige).toBe(20);
  });

  it("любимые сохраняются PUT с полным списком в `ids`; ответ — список слотов", async () => {
    const sent: Sent[] = [];

    const response = await createAchievementsApi(server(sent, { favorites: ["b", "a"] })).setFavorites(["b", "a"]);

    expect(sent).toEqual([{ method: "PUT", path: "/api/v1/achievements/favorites", body: { ids: ["b", "a"] } }]);
    expect(response.ok && response.data.favorites).toEqual(["b", "a"]);
  });

  it("ошибка `achievement_not_unlocked` распознаётся и получает свой текст, прочие — общий", () => {
    expect(ACHIEVEMENT_NOT_UNLOCKED).toBe("achievement_not_unlocked");
    expect(favoriteFailureKey("achievement_not_unlocked")).toBe("achievements.favorite.locked");
    expect(favoriteFailureKey("rate_limited")).toBe("achievements.favoriteFailed");
    expect(favoriteFailureKey(undefined)).toBe("achievements.favoriteFailed");
  });
});

describe("строка рейтинга", () => {
  const ENTRY = { rank: 1, name: "Лидер", photoUrl: null, survivalSec: 600, level: 12, startingWeaponId: "knife", enemiesKilled: 900, isMe: false };
  const board = (entries: unknown[]) => ({ difficultyId: "hard", entries, me: null, totalPlayers: entries.length });

  it("без `prestige` (старый сервер) разбирается, с `prestige` — тоже", async () => {
    const old = await createRunsApi(server([], board([ENTRY]))).leaderboard("hard");
    const fresh = await createRunsApi(server([], board([{ ...ENTRY, prestige: 35 }, { ...ENTRY, rank: 2, prestige: 0 }]))).leaderboard("hard");

    expect(old.ok && old.data.entries[0]?.prestige).toBeUndefined();
    expect(fresh.ok && fresh.data.entries.map((entry) => entry.prestige)).toEqual([35, 0]);
  });
});

describe("тексты витрины", () => {
  const KEYS = [
    "achievements.loading",
    "achievements.failed",
    "achievements.prestige",
    "achievements.opened",
    "achievements.prestigeGain",
    "achievements.category.combat",
    "achievements.category.collection",
    "achievements.category.mastery",
    "achievements.category.friends",
    "achievements.rung",
    "achievements.rarity",
    "achievements.rarity.common",
    "achievements.rarity.uncommon",
    "achievements.rarity.rare",
    "achievements.rarity.epic",
    "achievements.hidden.title",
    "achievements.favorites.title",
    "achievements.favorites.empty",
    "achievements.favorite.add",
    "achievements.favorite.remove",
    "achievements.favorites.full",
    "achievements.favorite.locked",
    "achievements.favoriteFailed",
    "task.kind.friends",
    "task.kind.account_level",
  ];

  it("все ключи шагов лежат в ru-tasks.json и не пусты", () => {
    const dictionary = ruTasks as Record<string, string>;
    for (const key of KEYS) expect(dictionary[key], key).toBeTruthy();
  });

  it("профиль и рейтинг: свои ключи в основном словаре", () => {
    const dictionary = ru as Record<string, string>;
    for (const key of ["profile.prestige", "profile.favorites", "rating.prestige"]) expect(dictionary[key], key).toBeTruthy();
  });
});
