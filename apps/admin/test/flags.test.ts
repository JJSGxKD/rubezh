import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { fetchFlags, flagProblem, flagReach, removeFlag, saveFlag, type FlagInput } from "../src/api/flags";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

const FLAG = { key: "shop.v2", enabled: true, platforms: ["telegram"], percent: 30, note: null, updatedBy: null, updatedAt: "2026-09-26T10:00:00.000Z" };
const INPUT: FlagInput = { key: "shop.v2", enabled: true, platforms: ["telegram"], percent: 30, note: "" };

describe("флаги в панели", () => {
  it("список, сохранение без пустой заметки и снятие по ключу", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { flags: [FLAG] } }), json(200, { data: FLAG }), json(200, { data: { removed: true } }));
    const api = new AdminApi(fetch);

    const list = await fetchFlags(api);
    expect(list.ok && list.data.flags[0]?.platforms).toEqual(["telegram"]);

    await saveFlag(api, INPUT);
    expect(calls[1]?.url).toBe("/api/v1/admin/flags");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ key: "shop.v2", enabled: true, platforms: ["telegram"], percent: 30 });

    const removed = await removeFlag(api, "shop.v2");
    expect(removed.ok && removed.data.removed).toBe(true);
    expect(calls[2]?.url).toBe("/api/v1/admin/flags/shop.v2/remove");
  });

  it("форма проверяет то же, что сервер", () => {
    expect(flagProblem(INPUT)).toBeNull();
    expect(flagProblem({ ...INPUT, key: "Shop" })).not.toBeNull();
    expect(flagProblem({ ...INPUT, key: "s" })).not.toBeNull();
    expect(flagProblem({ ...INPUT, percent: 101 })).not.toBeNull();
    expect(flagProblem({ ...INPUT, percent: 2.5 })).not.toBeNull();
    expect(flagProblem({ ...INPUT, note: "x".repeat(201) })).not.toBeNull();
  });

  it("кому включён — одной строкой", () => {
    expect(flagReach({ enabled: false, platforms: [], percent: 100 })).toBe("никому");
    expect(flagReach({ enabled: true, platforms: [], percent: 0 })).toBe("никому");
    expect(flagReach({ enabled: true, platforms: [], percent: 100 })).toBe("все площадки");
    expect(flagReach({ enabled: true, platforms: ["telegram", "vk"], percent: 30 })).toBe("telegram, vk, 30% игроков");
    expect(SECTIONS.find((section) => section.id === "flags")?.permission).toBe("flags.edit");
  });
});
