import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { conversion, createLink, fetchLinks, SLUG } from "../src/api/links";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

const LINK = { code: "Ab12Cd34Ef", url: "https://rubezh.example/r/Ab12Cd34Ef", platform: "telegram", campaign: "launch", source: "tg", medium: null, note: null, createdAt: "2026-09-25T10:00:00.000Z" };

describe("ссылки кампаний", () => {
  it("список со статистикой и новая ссылка", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { links: [{ ...LINK, clicks: 40, clicks30d: 12, launches: 10 }] } }), json(200, { data: LINK }));
    const api = new AdminApi(fetch);
    const list = await fetchLinks(api);
    expect(list.ok && list.data.links[0]?.launches).toBe(10);
    await createLink(api, { campaign: "launch", source: "tg" });
    expect(calls[1]?.url).toBe("/api/v1/admin/links");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ campaign: "launch", source: "tg" });
  });

  it("формат кампании и конверсия", () => {
    expect(SLUG.test("launch-post_2")).toBe(true);
    expect(SLUG.test("Канал запуска")).toBe(false);
    expect(SLUG.test("-start")).toBe(false);
    expect(conversion({ clicks: 40, launches: 10 })).toBe(25);
    expect(conversion({ clicks: 0, launches: 0 })).toBeNull();
    expect(SECTIONS.find((section) => section.id === "links")?.permission).toBe("links.manage");
  });
});
