import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { boardsViewSchema, fetchPlayerSeasons, fetchRatingBoards, fetchSeason, fetchSeasons, playerSeasonsSchema, scoreText, seasonViewSchema, weekTitle } from "../src/api/rating";
import { locateSection, parseRoute, SECTIONS } from "../src/routes";
import { HELP } from "../src/ui/help";
import { fakeFetch, json } from "./helpers";

/**
 * Рейтинг в панели (tasks/T-0381, docs/35-stage4-plan.md Р189): формы ответов
 * T-0380, адреса запросов, подписи чисел и недель, маршрут раздела.
 */

const ACCOUNT = "3c8f3a52-2d4e-4c55-9d0e-6f3b2a1c0d9e";
const REWARD = { kind: "place", coins: 120, prestige: 5, status: "pending", claimedAt: null };
const CARD = { key: "2026-11-02", startsAt: "2026-11-02T00:00:00.000Z", endsAt: "2026-11-09T00:00:00.000Z", closedAt: "2026-11-09T00:00:05.000Z", players: 40, rewarded: 12, scoring: "points" };

describe("схемы ответов рейтинга", () => {
  it("доска: ответ разбирается, лишнее поле не роняет", () => {
    const body = {
      period: "week",
      difficulty: "hard",
      board: "common",
      scoring: "time",
      seasonKey: "2026-11-02",
      total: 1,
      entries: [{ place: 1, accountId: ACCOUNT, name: "Ратмир", score: 754, survivalSec: 754, division: "ruby", extra: 1 }],
      newField: true,
    };
    expect(boardsViewSchema.safeParse(body).success).toBe(true);
  });

  it("доска: без обязательного поля — ошибка", () => {
    expect(boardsViewSchema.safeParse({ period: "week", difficulty: "hard", board: "common", scoring: "time", seasonKey: null, entries: [] }).success).toBe(false);
  });

  it("сезон: награда и дивизион разбираются, неизвестная сложность — ошибка", () => {
    const row = { place: 1, accountId: ACCOUNT, name: "Ратмир", best: 1830, boardSize: 40, division: "gold", reward: REWARD };
    expect(seasonViewSchema.safeParse({ season: CARD, difficulty: "hard", board: "common", total: 1, rows: [row] }).success).toBe(true);
    expect(seasonViewSchema.safeParse({ season: CARD, difficulty: "insane", board: "common", total: 1, rows: [row] }).success).toBe(false);
  });

  it("места игрока: колонка доски необязательна", () => {
    const result = { difficulty: "hard", best: 754, place: 3, boardSize: 40, division: "silver" };
    const body = { seasons: [{ key: "2026-11-02", startsAt: CARD.startsAt, scoring: "time", results: [result, { ...result, board: "full" }], reward: null }] };
    expect(playerSeasonsSchema.safeParse(body).success).toBe(true);
  });
});

describe("запросы рейтинга", () => {
  it("адреса и параметры — как у ручек T-0380", async () => {
    const boards = { period: "week", difficulty: "hard", board: "common", scoring: "time", seasonKey: null, total: 0, entries: [] };
    const { fetch, calls } = fakeFetch(
      json(200, { data: boards }),
      json(200, { data: { seasons: [], next: null } }),
      json(200, { data: { season: CARD, difficulty: "hard", board: "common", total: 0, rows: [] } }),
      json(200, { data: { seasons: [] } }),
    );
    const api = new AdminApi(fetch);

    expect((await fetchRatingBoards(api, { difficulty: "hard", period: "week", board: "common", limit: 100 })).ok).toBe(true);
    expect((await fetchSeasons(api, "2026-11-02")).ok).toBe(true);
    expect((await fetchSeason(api, "2026-11-02", { difficulty: "hard", board: "common", offset: 0, limit: 100 })).ok).toBe(true);
    expect((await fetchPlayerSeasons(api, ACCOUNT)).ok).toBe(true);

    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ["GET", "/api/v1/admin/rating/boards?difficulty=hard&period=week&board=common&limit=100"],
      ["GET", "/api/v1/admin/rating/seasons?before=2026-11-02"],
      ["GET", "/api/v1/admin/rating/seasons/2026-11-02?difficulty=hard&board=common&offset=0&limit=100"],
      ["GET", `/api/v1/admin/players/${ACCOUNT}/seasons`],
    ]);
  });

  it("первая страница архива — без before", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { seasons: [], next: null } }));
    await fetchSeasons(new AdminApi(fetch), null);
    expect(calls[0]?.url).toBe("/api/v1/admin/rating/seasons");
  });
});

describe("подписи", () => {
  it("результат: время или очки", () => {
    expect(scoreText(754, "time")).toBe("12:34");
    expect(scoreText(1830, "points")).toMatch(/^1\s830 оч\.$/u);
  });

  it("неделя словами, в том числе через границу месяца", () => {
    expect(weekTitle("2026-11-02")).toBe("2–8 ноября 2026");
    expect(weekTitle("2026-11-30")).toBe("30 ноября – 6 декабря 2026");
  });
});

describe("раздел «Рейтинг»", () => {
  it("адрес сезона на сложности: раздел, ключ, вкладка-сложность", () => {
    expect(parseRoute("#/rating/2026-11-02/hard")).toEqual({ section: "rating", id: "2026-11-02", tab: "hard" });
  });

  it("в группе «Вовлечение» под правом players.view", () => {
    const found = locateSection("rating");
    expect(found?.group.title).toBe("Вовлечение");
    expect(found?.section.permission).toBe("players.view");
    expect(SECTIONS.some((section) => section.id === "rating")).toBe(true);
  });
});

describe("пояснения рейтинга", () => {
  const texts = [HELP.rating.section, HELP.rating.division, HELP.rating.board, HELP.players.seasonPlaces];

  it("есть, читаются фразой и не обращаются на «ты»", () => {
    for (const text of texts) {
      expect(text.trim()).not.toBe("");
      expect(text.length).toBeLessThanOrEqual(400);
      expect(text).not.toMatch(/(^|[^а-яё])(ты|тебе|тебя|твой|твоя|твои)([^а-яё]|$)/iu);
    }
  });
});
