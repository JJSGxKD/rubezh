import { beforeEach, describe, expect, it } from "vitest";
import { hasTranslation } from "../src/i18n";
import "../src/i18n/home";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { createHomeApi, forgetHomeForTests, safeLink, slideImageUrl, type HomeSlide } from "../src/state/home-api";
import { textOf, titleOf } from "../src/screens/home-slide";

// Карусель главной (docs/35-stage4-plan.md WP42): слайды решает сервер, клиент
// рисует; незнакомый вид слайда — сервер новее клиента — отбрасывается по
// одному. Свежесть ответа, общего с виджетами, — в home-widgets.test.ts.

const NOW = Date.parse("2026-10-04T12:00:00.000Z");

function server(answer: unknown, calls: string[] = []): ApiRequest {
  return async <T,>(path: string, schema: object, init?: { method?: string }): Promise<ApiResult<T>> => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
    return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
  };
}

const ALL: HomeSlide[] = [
  { id: "promo:bundle_m", kind: "promo", percent: 30, endsAt: new Date(NOW + 3_600_000).toISOString(), title: null },
  { id: "changelog", kind: "changelog", versions: 2 },
  { id: "vip", kind: "vip", stars: 700 },
  { id: "starter", kind: "starter", stars: 25 },
  { id: "invite", kind: "invite" },
  { id: "channel", kind: "channel", url: "https://t.me/rubezh" },
  { id: "task:a", kind: "task", title: null, image: null, reward: { coins: 100, gems: 0, shards: 0 } },
];

beforeEach(() => forgetHomeForTests());

describe("слайды главной с сервера", () => {
  it("свои — как есть; незнакомый вид и битый слайд — мимо, остальные на месте", async () => {
    const calls: string[] = [];
    const answer = { slides: [ALL[2], { id: "x", kind: "lottery" }, { id: "vip2", kind: "vip" }, ALL[4]] };
    const result = await createHomeApi(server(answer, calls)).home();
    expect(result.ok && result.data.slides.map((slide) => slide.id)).toEqual(["vip", "invite"]);
    expect(calls).toEqual(["GET /api/v1/me/home"]);
  });

  it("слайд команды: незнакомый значок — значком объявления; экран, которого клиент не знает, — мимо", async () => {
    const team = { id: "team:1", kind: "team", slideId: "1", title: "Турнир", text: "Призы — самоцветы", image: null, icon: "rocket-launch", target: { kind: "screen", screen: "rating" } };
    const answer = { slides: [team, { ...team, id: "team:2", target: { kind: "screen", screen: "clans" } }, { ...team, id: "team:3", target: { kind: "link", url: "https://t.me/rubezh" } }] };
    const result = await createHomeApi(server(answer)).home();
    expect(result.ok && result.data.slides.map((slide) => slide.id)).toEqual(["team:1", "team:3"]);
  });

  it("картинка — только путь медиа сервера; ссылка канала — только https", () => {
    const hash = "a".repeat(64);
    expect(slideImageUrl(`/api/v1/media/${hash}.webp`, "https://api.gonet.fun/")).toBe(`https://api.gonet.fun/api/v1/media/${hash}.webp`);
    expect(slideImageUrl("https://evil.example/x.webp", "https://api.gonet.fun")).toBeNull();
    expect(slideImageUrl(`/api/v1/media/${hash}.webp`, undefined)).toBeNull();
    expect(safeLink("https://t.me/rubezh")).toBe("https://t.me/rubezh");
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink("tg://resolve?domain=x")).toBeNull();
  });
});

describe("тексты слайдов", () => {
  it("у каждого вида — заголовок и подпись словами; текст команды и партнёра — их словами", () => {
    for (const slide of ALL) {
      expect(titleOf(slide), slide.id).not.toMatch(/^home\./);
      expect(textOf(slide, NOW), slide.id).not.toMatch(/^home\./);
      expect(hasTranslation(`home.slide.${slide.kind}.text`), slide.kind).toBe(true);
    }
    expect(textOf(ALL[1] as HomeSlide, NOW)).toBe("2 новые версии");
    // Слайд команды — её словами, без словаря.
    const team: HomeSlide = { id: "team:1", kind: "team", slideId: "1", title: "Турнир выходного дня", text: "Призы — самоцветы", image: null, icon: "trophy", target: { kind: "screen", screen: "rating" } };
    expect([titleOf(team), textOf(team, NOW)]).toEqual(["Турнир выходного дня", "Призы — самоцветы"]);
    expect(titleOf({ ...(ALL[6] as Extract<HomeSlide, { kind: "task" }>), title: "Канал партнёра" })).toBe("Канал партнёра");
  });

  it("акция: заголовок команды или свой, подпись — сколько осталось; кончившаяся так и называется", () => {
    const promo = ALL[0] as Extract<HomeSlide, { kind: "promo" }>;
    expect([titleOf(promo), textOf(promo, NOW)]).toEqual(["Акция в магазине", "ещё 1 ч"]);
    expect(titleOf({ ...promo, title: "Осенняя распродажа" })).toBe("Осенняя распродажа");
    expect(textOf(promo, Date.parse(promo.endsAt))).toBe("Акция закончилась");
  });

  it("задание: награда числом перед подписью, одни осколки — словами", () => {
    const task = ALL[6] as Extract<HomeSlide, { kind: "task" }>;
    expect(textOf(task, NOW)).toBe("за задание");
    expect(textOf({ ...task, reward: { coins: 0, gems: 0, shards: 3 } }, NOW)).toBe("Награда за выполнение");
  });
});
