import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LeaderboardEntry } from "@bh/shared-types";
import { COLORS } from "../src/design-system/tokens";
import "../src/i18n/season";
import { LeaderboardRow, YouStrip } from "../src/screens/meta/rating";
import { Podium } from "../src/screens/meta/rating-podium";
import {
  DIVISION_IDS,
  divisionFirstRank,
  divisionId,
  divisionPlace,
  hintKey,
  nextDivisionGap,
  nextPlace,
  podiumSteps,
  scoreOf,
  seasonDaysLeft,
  styleAxis,
  STYLE_AXES,
} from "../src/screens/meta/rating-rules";
import { DivisionBadge, StyleBadge, StyleCard } from "../src/screens/meta/rating-style";
import { STYLE_GLYPHS } from "../src/screens/game-glyphs";
import { ANALYTICS_EVENTS } from "../src/state/analytics";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { leaderboardSchema } from "../src/state/runs-api";
import { createSeasonsApi, createStyleApi, type SeasonBoard, type SeasonData } from "../src/state/seasons-api";
import { SeasonTab, type BoardState } from "../src/screens/meta/rating-season";

// Рейтинг v2 (tasks/T-0296): главное число — очки (или время в сезоне по
// времени), пьедестал, «Ты» с очками до следующего места, дивизион и «Твой
// стиль». Правила — чистые функции; экран только показывает их ответы.

const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/ /g, " ").trim();

const ENTRY: LeaderboardEntry = {
  rank: 4,
  name: "Злата",
  photoUrl: null,
  survivalSec: 1_908,
  level: 41,
  startingWeaponId: "spark",
  enemiesKilled: 2_400,
  isMe: false,
  points: 8_120,
  style: "h",
  division: "gold",
};

const entry = (patch: Partial<LeaderboardEntry>): LeaderboardEntry => ({ ...ENTRY, ...patch });

describe("до следующего места", () => {
  const above = [entry({ rank: 36, points: 4_400 }), entry({ rank: 37, points: 4_345 })];

  it("38-й с 4 205 очками и 37-й с 4 345 — 140 очков до 37-го", () => {
    expect(nextPlace({ rank: 38, points: 4_205, survivalSec: 600 }, above, "points")).toEqual({ kind: "gap", place: 37, gap: 140, unit: "points" });
  });

  it("первое место — «Ты первый», считать не с кем", () => {
    expect(nextPlace({ rank: 1, points: 9_999, survivalSec: 600 }, above, "points")).toEqual({ kind: "first" });
  });

  it("соседа нет на доске — берётся ближайший выше из показанных, и в ответе его место", () => {
    const top = [entry({ rank: 49, points: 3_000 }), entry({ rank: 50, points: 2_900 })];
    expect(nextPlace({ rank: 300, points: 1_000, survivalSec: 600 }, top, "points")).toEqual({ kind: "gap", place: 50, gap: 1_900, unit: "points" });
  });

  it("выше никого не видно — цели нет, а не выдуманное число", () => {
    expect(nextPlace({ rank: 300, points: 1_000, survivalSec: 600 }, [], "points")).toEqual({ kind: "unknown" });
  });

  it("ровно столько же очков — разрыв не нулевой: чтобы обойти, нужно хоть чуть больше", () => {
    expect(nextPlace({ rank: 38, points: 4_345, survivalSec: 600 }, above, "points")).toMatchObject({ kind: "gap", gap: 1 });
  });

  it("сезон по времени — разрыв в секундах", () => {
    const rows = [entry({ rank: 2, points: null, survivalSec: 700 })];
    expect(nextPlace({ rank: 3, points: null, survivalSec: 640 }, rows, "time")).toEqual({ kind: "gap", place: 2, gap: 60, unit: "time" });
  });

  it("у строки нет очков в сезоне по очкам — цели нет", () => {
    const rows = [entry({ rank: 2, points: null })];
    expect(nextPlace({ rank: 3, points: 500, survivalSec: 640 }, rows, "points")).toEqual({ kind: "unknown" });
  });
});

describe("главное число строки", () => {
  it("по очкам: очки крупно, время подписью", () => {
    expect(scoreOf({ points: 4_205, survivalSec: 612 }, "points")).toEqual({ kind: "points", value: 4_205, sub: 612 });
  });

  it("сезон по времени или очков нет (старый сервер) — время главным, подписи нет", () => {
    expect(scoreOf({ points: 4_205, survivalSec: 612 }, "time")).toEqual({ kind: "time", value: 612, sub: null });
    expect(scoreOf({ survivalSec: 612 }, "points")).toEqual({ kind: "time", value: 612, sub: null });
    expect(scoreOf({ points: null, survivalSec: 612 }, "points")).toEqual({ kind: "time", value: 612, sub: null });
  });
});

describe("пьедестал", () => {
  const three = [entry({ rank: 1, name: "Велимир" }), entry({ rank: 2, name: "Ярослава" }), entry({ rank: 3, name: "Мирон" })];

  it("три игрока: места 2 · 1 · 3 слева направо", () => {
    expect(podiumSteps(three).map((step) => step.place)).toEqual([2, 1, 3]);
    expect(podiumSteps(three).map((step) => step.entry.name)).toEqual(["Ярослава", "Велимир", "Мирон"]);
  });

  it("два игрока — две ступени, порядок 2 · 1", () => {
    expect(podiumSteps(three.slice(0, 2)).map((step) => step.place)).toEqual([2, 1]);
  });

  it("один — одна ступень; пустая доска — ни одной; лишние строки пьедестал не берёт", () => {
    expect(podiumSteps(three.slice(0, 1)).map((step) => step.place)).toEqual([1]);
    expect(podiumSteps([])).toEqual([]);
    expect(podiumSteps([...three, entry({ rank: 4 })]).length).toBe(3);
  });

  it("рисуется обликом-аватаром, именем и очками под ступенью, порядок разметки — 2 · 1 · 3", () => {
    const html = renderToStaticMarkup(createElement(Podium, { entries: three.map((row, index) => ({ ...row, points: 9_812 - index * 400 })), scoring: "points" }));
    const body = text(html);
    expect(body.indexOf("Ярослава")).toBeLessThan(body.indexOf("Велимир"));
    expect(body.indexOf("Велимир")).toBeLessThan(body.indexOf("Мирон"));
    expect(body).toContain("9 812");
    expect(body).toContain("9 012");
  });

  it("с двумя игроками ступеней две", () => {
    const html = renderToStaticMarkup(createElement(Podium, { entries: three.slice(0, 2), scoring: "points" }));
    expect(html.match(/data-place="/g)?.length).toBe(2);
  });
});

describe("подсказка к слабой оси", () => {
  it("слабая ось — ключ rating.hint.<ось>, у каждой из пяти свой", () => {
    expect(hintKey("k")).toBe("rating.hint.k");
    expect(STYLE_AXES.map(hintKey)).toEqual(["rating.hint.t", "rating.hint.k", "rating.hint.h", "rating.hint.c", "rating.hint.b"]);
  });

  it("незнакомая ось и дивизион не проходят: сервер новее клиента", () => {
    expect(styleAxis("k")).toBe("k");
    expect(styleAxis("z")).toBeNull();
    expect(styleAxis(null)).toBeNull();
    expect(divisionId("silver")).toBe("silver");
    expect(divisionId("platinum")).toBeNull();
    expect(divisionId(undefined)).toBeNull();
  });
});

describe("дивизион по месту", () => {
  it("первое место дивизиона на доске в 1 000: золото с 11-го, серебро со 101-го, бронза с 351-го", () => {
    expect(divisionFirstRank("ruby", 1_000)).toBe(1);
    expect(divisionFirstRank("gold", 1_000)).toBe(11);
    expect(divisionFirstRank("silver", 1_000)).toBe(101);
    expect(divisionFirstRank("bronze", 1_000)).toBe(351);
  });

  it("место внутри дивизиона считается от его начала", () => {
    expect(divisionPlace(11, "gold", 1_000)).toBe(1);
    expect(divisionPlace(140, "silver", 1_000)).toBe(40);
    expect(divisionPlace(351, "bronze", 1_000)).toBe(1);
  });

  it("доска из трёх: рубин — первый, золото начинается со второго", () => {
    expect(divisionFirstRank("gold", 3)).toBe(2);
  });

  it("до следующего дивизиона — по очкам последнего места выше, если оно на экране", () => {
    // серебро 101–350, золото кончается на 100-м месте
    const board = [entry({ rank: 100, points: 5_000 })];
    expect(nextDivisionGap("silver", 1_000, { points: 4_390, survivalSec: 600 }, board, "points")).toEqual({ next: "gold", gap: 610, unit: "points" });
  });

  it("последнее место старшего дивизиона не видно — строки нет, чисел не выдумываем", () => {
    expect(nextDivisionGap("silver", 1_000, { points: 4_390, survivalSec: 600 }, [entry({ rank: 12, points: 7_000 })], "points")).toBeNull();
  });

  it("у рубина старшего дивизиона нет", () => {
    expect(nextDivisionGap("ruby", 1_000, { points: 9_000, survivalSec: 600 }, [], "points")).toBeNull();
  });

  it("четыре дивизиона, порядок от высшего", () => {
    expect([...DIVISION_IDS]).toEqual(["ruby", "gold", "silver", "bronze"]);
  });
});

describe("сколько дней до конца сезона", () => {
  it("целые сутки вверх: остался день и час — «2 дн.»", () => {
    expect(seasonDaysLeft(86_400 + 3_600)).toBe(2);
    expect(seasonDaysLeft(86_400)).toBe(1);
    expect(seasonDaysLeft(60)).toBe(1);
  });

  it("время вышло — ноль, подпись скажет «закрывается»", () => {
    expect(seasonDaysLeft(0)).toBe(0);
    expect(seasonDaysLeft(-5)).toBe(0);
  });
});

describe("разбор ответов", () => {
  const board = (patch: Record<string, unknown>) => ({
    difficultyId: "hard",
    entries: [
      {
        rank: 1,
        name: "Велимир",
        photoUrl: null,
        survivalSec: 1_908,
        level: 41,
        startingWeaponId: "spark",
        enemiesKilled: 2_400,
        isMe: false,
        ...patch,
      },
    ],
    me: { rank: 38, survivalSec: 600, points: 4_205, style: "c", division: "silver" },
    totalPlayers: 900,
  });

  it("очки, стиль и дивизион читаются и у строки, и у «меня»", () => {
    const parsed = leaderboardSchema.safeParse(board({ points: 9_812, style: "t", division: "ruby" }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.entries[0]).toMatchObject({ points: 9_812, style: "t", division: "ruby" });
    expect(parsed.data.me).toMatchObject({ points: 4_205, style: "c", division: "silver" });
  });

  it("сервер до очков полей не знал — ответ проходит без них", () => {
    const parsed = leaderboardSchema.safeParse({ ...board({}), me: { rank: 3, survivalSec: 600 } });
    expect(parsed.success).toBe(true);
  });

  it("стиль и дивизион могут быть пустыми: забега с очками нет", () => {
    expect(leaderboardSchema.safeParse(board({ points: null, style: null, division: null })).success).toBe(true);
  });

  it("очки строкой — мусор, а не число", () => {
    expect(leaderboardSchema.safeParse(board({ points: "много" })).success).toBe(false);
  });

  const overview = {
    enabled: true,
    startsAt: null,
    season: { key: "2026-11-02", startsAt: "2026-11-02T00:00:00.000Z", endsAt: "2026-11-09T00:00:00.000Z", secondsLeft: 273_600 },
    minBoard: 10,
    thresholds: { hard: 180 },
    thresholdPoints: 2_000,
    scoring: "points",
    thresholdReward: { coins: 100, prestige: 5 },
    placeLadder: [],
    difficultyMul: { hard: 1.7 },
    mine: { hard: 612 },
    minePoints: { hard: 4_205 },
    division: { hard: "silver" },
    pending: [],
    history: [
      {
        seasonKey: "2026-10-26",
        startsAt: "2026-10-26T00:00:00.000Z",
        endsAt: "2026-11-02T00:00:00.000Z",
        scoring: "time",
        results: [{ difficulty: "hard", bestSec: 301, place: 2, boardSize: 14, division: "gold" }],
        reward: null,
      },
    ],
  };

  const request =
    (answer: unknown): ApiRequest =>
    async <T,>(_path: string, schema: object): Promise<ApiResult<T>> => {
      const { z } = await import("zod/mini");
      const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
      return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
    };

  it("обзор сезона несёт по чему ранжирован сезон, очки недели и дивизион", async () => {
    const response = await createSeasonsApi(request(overview)).overview();
    expect(response.ok).toBe(true);
    if (!response.ok || !response.data.enabled) return;
    expect(response.data).toMatchObject({ scoring: "points", minePoints: { hard: 4_205 }, division: { hard: "silver" } });
    expect(response.data.history[0]).toMatchObject({ scoring: "time" });
  });

  it("сервер до очков не знал полей — сезон считается по времени, очков и дивизиона нет", async () => {
    const old = { ...overview } as Record<string, unknown>;
    for (const key of ["scoring", "minePoints", "division", "thresholdPoints"]) delete old[key];
    const response = await createSeasonsApi(request(old)).overview();
    expect(response.ok).toBe(true);
    if (!response.ok || !response.data.enabled) return;
    expect(response.data.scoring).toBe("time");
    expect(response.data.minePoints).toEqual({});
    expect(response.data.division).toEqual({});
  });

  it("«Твой стиль»: ось и недостающие забеги", async () => {
    const ready = await createStyleApi(request({ style: "c", strong: "c", weak: "k", axes: { t: 1.2, k: 0.6, h: 0.9, c: 1.5, b: 1 }, runs: 10, missing: 0 })).myStyle();
    expect(ready).toMatchObject({ ok: true, data: { strong: "c", weak: "k", missing: 0 } });
    const few = await createStyleApi(request({ style: null, strong: null, weak: null, axes: null, runs: 1, missing: 2 })).myStyle();
    expect(few).toMatchObject({ ok: true, data: { strong: null, runs: 1, missing: 2 } });
  });
});

describe("строка рейтинга", () => {
  const row = (patch: Partial<LeaderboardEntry>, scoring: "points" | "time" = "points"): string =>
    text(renderToStaticMarkup(createElement(LeaderboardRow, { entry: entry(patch), index: 0, scoring })));

  it("очки крупно, время забега подписью, стиль — значком с именем", () => {
    const body = row({ points: 4_205, survivalSec: 1_908, style: "c" });
    expect(body).toContain("4 205");
    expect(body).toContain("31:48");
    expect(body).toContain("Тень");
  });

  it("сезон по времени — время главным числом, очков в строке нет", () => {
    const body = row({ points: null, survivalSec: 1_908 }, "time");
    expect(body).toContain("31:48");
    expect(body).not.toContain("8 120");
  });

  it("стиля нет — значка нет, строка не ломается", () => {
    const body = row({ style: null });
    expect(body).toContain("Злата");
    for (const name of ["Стена", "Ураган", "Охотник", "Тень", "Мастер"]) expect(body).not.toContain(name);
  });

  it("незнакомый стиль с сервера значка не получает", () => {
    expect(row({ style: "mystery" })).not.toContain("mystery");
  });
});

describe("«Ты» внизу", () => {
  const above = [entry({ rank: 37, points: 4_345 })];
  const strip = (me: Parameters<typeof YouStrip>[0]["me"], entries: readonly LeaderboardEntry[] = above): string =>
    text(renderToStaticMarkup(createElement(YouStrip, { me, entries, scoring: "points", total: 900 })));

  it("место, очки до следующего и дивизион одной строкой", () => {
    const body = strip({ rank: 38, points: 4_205, survivalSec: 600, division: "silver" });
    expect(body).toContain("38");
    expect(body).toContain("Ты");
    expect(body).toContain("до 37-го — 140 очков");
    expect(body).toContain("серебро");
  });

  it("первое место — «Ты первый»", () => {
    const body = strip({ rank: 1, points: 9_999, survivalSec: 600, division: "ruby" }, []);
    expect(body).toContain("Ты первый");
    expect(body).toContain("рубин");
    expect(body).not.toContain("до ");
  });

  it("нет забега — зовём сыграть", () => {
    expect(strip(null)).toContain("Сыграй забег, чтобы попасть в рейтинг");
  });

  it("цель выше не видна — без числа, но место и дивизион остаются", () => {
    const body = strip({ rank: 300, points: 1_000, survivalSec: 600, division: "bronze" }, []);
    expect(body).toContain("300");
    expect(body).toContain("бронза");
    expect(body).not.toContain("очков");
  });
});

describe("«Твой стиль»", () => {
  const card = (summary: Parameters<typeof StyleCard>[0]["summary"]): string => text(renderToStaticMarkup(createElement(StyleCard, { summary })));

  it("значок и имя стиля, сильная и слабая ось, подсказка к слабой", () => {
    const body = card({ style: "c", strong: "c", weak: "k", axes: { t: 1.2, k: 0.6, h: 0.9, c: 1.5, b: 1 }, runs: 10, missing: 0 });
    expect(body).toContain("Твой стиль");
    expect(body).toContain("Тень");
    expect(body).toContain("Сильная сторона");
    expect(body).toContain("Чистота");
    expect(body).toContain("Где расти");
    expect(body).toContain("Натиск");
    expect(body).toContain("Темп поднимут «Гроза» и «Мощь»");
  });

  it("забегов мало — сколько сыграть ещё, без осей и подсказки", () => {
    const body = card({ style: null, strong: null, weak: null, axes: null, runs: 1, missing: 2 });
    expect(body).toContain("Сыграй ещё 2, чтобы узнать свой стиль");
    expect(body).not.toContain("Где расти");
  });
});

describe("значки стиля и дивизиона", () => {
  it("пять стилей — пять значков одной формы, разные знаки", () => {
    expect(Object.keys(STYLE_GLYPHS).sort()).toEqual([...STYLE_AXES].sort());
    const shapes = new Set(Object.values(STYLE_GLYPHS).map((glyph) => JSON.stringify(glyph)));
    expect(shapes.size).toBe(5);
  });

  it("стиль называется словом, дивизион — словом и тоном токена", () => {
    const names = STYLE_AXES.map((axis) => text(renderToStaticMarkup(createElement(StyleBadge, { axis }))));
    expect(names).toEqual(["Стена", "Ураган", "Охотник", "Тень", "Мастер"]);
    const divisions = DIVISION_IDS.map((division) => renderToStaticMarkup(createElement(DivisionBadge, { division })));
    expect(divisions.map(text)).toEqual(["Рубин", "Золото", "Серебро", "Бронза"]);
    for (const [index, html] of divisions.entries()) expect(html).toContain(`--division-${DIVISION_IDS[index]}`);
  });
});

describe("цвета дивизионов", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/design-system/tokens.css", import.meta.url)), "utf8");
  const channels = (hex: string): number[] => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  const luminance = (rgb: readonly number[]): number => {
    const lin = (value: number): number => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(rgb[0] ?? 0) + 0.7152 * lin(rgb[1] ?? 0) + 0.0722 * lin(rgb[2] ?? 0);
  };
  const contrast = (a: readonly number[], b: readonly number[]): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
  };
  const grounds = [COLORS.bg, COLORS.surface, COLORS.surfaceRaised, COLORS.surfaceSunken];

  it.each(DIVISION_IDS)("%s — токен есть, текст держит 4,5:1 на любой поверхности и на своей плашке", (division) => {
    const hex = new RegExp(`--division-${division}\\s*:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css)?.[1];
    expect(hex, `--division-${division}`).toBeDefined();
    const tone = channels(hex ?? "#000000");
    for (const ground of grounds) expect(contrast(tone, channels(ground))).toBeGreaterThanOrEqual(4.5);
    // плашка: тон 15% поверх лунки — как `badge-tinted`
    const sunken = channels(COLORS.surfaceSunken);
    const plate = tone.map((value, index) => value * 0.15 + (sunken[index] ?? 0) * 0.85);
    expect(contrast(tone, plate)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("события рейтинга", () => {
  it("круг и «Твой стиль» — в словаре клиента", () => {
    expect(ANALYTICS_EVENTS).toContain("rating_circle_changed");
    expect(ANALYTICS_EVENTS).toContain("rating_style_opened");
  });
});

describe("вкладка недели", () => {
  const data: SeasonData = {
    startsAt: null,
    season: { key: "2026-11-02", startsAt: "2026-11-02T00:00:00.000Z", endsAt: "2026-11-09T00:00:00.000Z", secondsLeft: 273_600 },
    minBoard: 10,
    thresholds: { hard: 180 },
    thresholdPoints: 2_000,
    scoring: "points",
    thresholdReward: { coins: 100, prestige: 5 },
    placeLadder: [],
    difficultyMul: { hard: 1.7 },
    mine: { hard: 612 },
    minePoints: { hard: 4_205 },
    division: { hard: "silver" },
    pending: [],
    history: [],
  };
  const row = (rank: number, division: string): SeasonBoard["entries"][number] => ({
    rank,
    name: `Игрок${rank}`,
    photoUrl: null,
    survivalSec: 600,
    level: 10,
    startingWeaponId: "spark",
    enemiesKilled: 100,
    isMe: false,
    points: 9_000 - rank,
    style: "t",
    division,
  });
  const board: SeasonBoard = {
    seasonKey: "2026-11-02",
    difficulty: "hard",
    scoring: "points",
    total: 1_000,
    entries: [row(1, "ruby"), row(2, "ruby"), row(3, "ruby"), row(4, "ruby"), row(100, "gold"), row(140, "silver"), row(141, "silver")],
    me: { rank: 150, survivalSec: 612, points: 4_205, style: "c", division: "silver" },
  };
  const render = (circle: "all" | "friends" | "division", overrides: Partial<SeasonData> = {}, state: BoardState = { status: "ready", board }): string =>
    text(
      renderToStaticMarkup(
        createElement(SeasonTab, {
          circle,
          onCircle: () => undefined,
          data: { ...data, ...overrides },
          receivedAt: 0,
          reload: async () => undefined,
          restriction: [],
          board: { state, retry: () => undefined },
          list: (view) => createElement("div", null, `${view.podium ? "подиум" : "список"}:${view.entries.map((entry) => `${entry.name}=${view.placeOf?.(entry) ?? entry.rank}`).join(",")}`),
          onInvite: () => undefined,
        }),
      ),
    );

  it("подпись сезона, плашка дивизиона и круги", () => {
    const body = render("all");
    expect(body).toContain("Сезон 2–8 ноября · ещё 4 дн.");
    expect(body).toContain("Ты — серебро");
    expect(body).toContain("топ-35% сезона");
    expect(body).toContain("лучший забег 4 205");
    for (const circle of ["Все", "Друзья", "Мой дивизион"]) expect(body).toContain(circle);
    expect(body).toContain("подиум:Игрок1=1");
  });

  it("«Мой дивизион» — только игроки серебра, место считается от начала дивизиона, без пьедестала", () => {
    const body = render("division");
    expect(body).toContain("список:Игрок140=40,Игрок141=41");
    expect(body).not.toContain("Игрок1=1");
  });

  it("дивизиона нет и в показанных строках нет — «Сыграй…» или пояснение, а не пустая вкладка", () => {
    expect(render("division", { division: {} }, { status: "ready", board: { ...board, me: null } })).toContain("Сыграй рейтинговый забег");
    expect(render("division", {}, { status: "ready", board: { ...board, entries: board.entries.slice(0, 4) } })).toContain("среди первых пятидесяти");
  });

  it("сезон по времени — плашка со временем, а не с очками", () => {
    const body = render("all", { scoring: "time" }, { status: "ready", board: { ...board, scoring: "time" } });
    expect(body).toContain("лучший забег 10:12");
  });

  it("ошибка загрузки — с «Повторить»", () => {
    expect(render("all", {}, { status: "failed" })).toContain("Повторить");
  });
});
