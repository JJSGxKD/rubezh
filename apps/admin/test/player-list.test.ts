import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { EMPTY_FILTERS, fetchPlayerList, filtersProblem, listQuery, sourceLabel, type PlayerListFilters } from "../src/api/player-list";
import { fakeFetch, json } from "./helpers";

// Список игроков с фильтрами в панели (docs/35-stage4-plan.md WP32): пустые
// поля не уходят на сервер, «по» включает день целиком, форма проверяет то же,
// что сервер, ответ разбирается схемой.

const ITEM = {
  accountId: "8f7c1c1e-7f0a-4b8e-9d7e-1c2b3a4d5e6f",
  platform: "telegram",
  displayName: "Дым",
  photoUrl: null,
  createdAt: "2026-09-01T10:00:00.000Z",
  lastSeenAt: "2026-09-30T10:00:00.000Z",
  level: 7,
  source: "click",
  campaign: "spring",
  payer: null,
  canMessage: true,
  banned: null,
  pii: null,
};

describe("список игроков в панели", () => {
  it("пустая форма — только порядок и страница; заполненная — все поля, «по» до полуночи следующего дня", () => {
    expect(listQuery(EMPTY_FILTERS, null)).toMatchObject({ sort: "registered", order: "desc", limit: 50, platform: undefined, cursor: undefined, registeredFrom: undefined });

    const filters: PlayerListFilters = { ...EMPTY_FILTERS, platform: "vk", levelMin: " 3 ", registeredFrom: "2026-09-01", registeredTo: "2026-09-30", campaign: " Spring ", payer: "yes", canMessage: "no", sort: "level", order: "asc" };
    const query = listQuery(filters, "c1");
    expect(query).toMatchObject({ platform: "vk", levelMin: "3", campaign: "spring", payer: "yes", canMessage: "no", sort: "level", order: "asc", cursor: "c1" });
    expect(new Date(String(query.registeredFrom)).getTime()).toBe(new Date(2026, 8, 1).getTime());
    expect(new Date(String(query.registeredTo)).getTime()).toBe(new Date(2026, 9, 1).getTime());
  });

  it("ограничения: «есть», «нет» или вид — уходят серверу как есть; «неважно» — не уходит", async () => {
    expect(listQuery({ ...EMPTY_FILTERS, restricted: "leaderboard" }, null).restricted).toBe("leaderboard");
    expect(listQuery(EMPTY_FILTERS, null).restricted).toBeUndefined();
    const { fetch, calls } = fakeFetch(json(200, { data: { players: [{ ...ITEM, restrictions: ["promo_codes"] }], nextCursor: null } }));
    const page = await fetchPlayerList(new AdminApi(fetch), { ...EMPTY_FILTERS, restricted: "any" }, null);
    expect(calls[0]?.url).toBe("/api/v1/admin/players/list?restricted=any&sort=registered&order=desc&limit=50");
    expect(page.ok && page.data.players[0]?.restrictions).toEqual(["promo_codes"]);
  });

  it("форма проверяет то же, что сервер", () => {
    expect(filtersProblem(EMPTY_FILTERS)).toBeNull();
    expect(filtersProblem({ ...EMPTY_FILTERS, levelMin: "5", levelMax: "2" })).not.toBeNull();
    expect(filtersProblem({ ...EMPTY_FILTERS, levelMin: "0" })).not.toBeNull();
    expect(filtersProblem({ ...EMPTY_FILTERS, levelMax: "2.5" })).not.toBeNull();
    expect(filtersProblem({ ...EMPTY_FILTERS, registeredFrom: "2026-09-30", registeredTo: "2026-09-01" })).not.toBeNull();
    expect(filtersProblem({ ...EMPTY_FILTERS, campaign: "весна" })).not.toBeNull();
  });

  it("страница — по адресу списка, ответ разбирается схемой; подпись источника", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { players: [ITEM], nextCursor: "next" } }), json(200, { data: { players: [{ ...ITEM, level: "семь" }], nextCursor: null } }));
    const api = new AdminApi(fetch);
    const page = await fetchPlayerList(api, { ...EMPTY_FILTERS, banned: "yes" }, null);
    expect(page.ok && page.data.nextCursor).toBe("next");
    expect(calls[0]?.url).toBe("/api/v1/admin/players/list?banned=yes&sort=registered&order=desc&limit=50");
    const broken = await fetchPlayerList(api, EMPTY_FILTERS, "next");
    expect(broken.ok).toBe(false);
    expect(calls[1]?.url).toContain("cursor=next");
    // Сервер старше ограничений поля не шлёт — у игрока их просто нет.
    expect(page.ok && page.data.players[0]?.restrictions).toEqual([]);
    expect(sourceLabel("invite")).toBe("по приглашению");
    expect(sourceLabel(null)).toBe("—");
    expect(sourceLabel("будущий")).toBe("будущий");
  });
});
