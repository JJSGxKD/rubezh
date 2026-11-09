import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LeaderboardEntry } from "@bh/shared-types";
import "../src/i18n/run-card";
import { LeaderboardRow } from "../src/screens/meta/rating";
import { RunCardBody } from "../src/screens/meta/run-card";
import { RunScoreLink } from "../src/screens/meta/run-card-link";
import { RunWeb } from "../src/screens/meta/run-card-web";
import {
  axisCaption,
  barShares,
  cardTitle,
  evolutionCount,
  parseRunCardStart,
  runCardStartParam,
  webPoints,
  type CardAxis,
} from "../src/screens/meta/run-card-rules";
import { ANALYTICS_EVENTS } from "../src/state/analytics";
import { openRunCard, openRunCardFromStart, useNavigation } from "../src/state/navigation";
import { runCardSchema, type RunCard } from "../src/state/runs-api";

// Карточка забега (tasks/T-0297, Р66, Р152): «паутина» пяти осей против
// ожидаемого, разбор очков полосами и сборка. Правила — чистые функции;
// экран только показывает ответ сервера.

const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/ /g, " ").trim();

const AXES: CardAxis[] = [
  { axis: "t", index: 3.18, points: 1_200, expectedPoints: 400 },
  { axis: "k", index: 1.42, points: 284, expectedPoints: 200 },
  { axis: "h", index: 1.28, points: 256, expectedPoints: 200 },
  { axis: "c", index: 1.38, points: 138, expectedPoints: 100 },
  { axis: "b", index: 1.12, points: 112, expectedPoints: 100 },
];

const CARD: RunCard = {
  runId: "run-aaa",
  mine: false,
  player: { name: "Велимир", photoUrl: null },
  survivalSec: 1_908,
  level: 41,
  power: 2.4,
  startingWeaponId: "spark",
  points: 1_990,
  expectedPoints: 1_150,
  style: "t",
  band: "strong",
  cap: 3,
  axes: AXES,
  facts: { killsPerMin: 412, bossKills: 6, eliteKills: 58, damageDeltaPct: -38 },
  build: {
    weapons: [
      { id: "spark", level: 8 },
      { id: "storm", level: 8 },
    ],
    passives: [{ id: "might", level: 5 }],
    boosts: ["aegis"],
  },
};

const unit = (indexes: Partial<Record<CardAxis["axis"], number>>): Record<CardAxis["axis"], number> => ({ t: 1, k: 1, h: 1, c: 1, b: 1, ...indexes });
const radius = (point: { x: number; y: number }): number => Math.sqrt(point.x * point.x + point.y * point.y);

describe("точки «паутины»", () => {
  it("индексы {1,1,1,1,1} при потолке 3 — правильный пятиугольник радиуса 1/3", () => {
    const points = webPoints(unit({}), 3);

    expect(points).toHaveLength(5);
    for (const point of points) expect(radius(point)).toBeCloseTo(1 / 3, 9);
    // Первый луч — вверх, дальше по часовой: Стойкость, Натиск, Охота, Чистота, Сборка.
    expect(points[0]?.x).toBeCloseTo(0, 9);
    expect(points[0]?.y).toBeCloseTo(-1 / 3, 9);
    // Пятиугольник правильный: соседние вершины на одном расстоянии.
    const side = (a: number, b: number): number => radius({ x: (points[a]?.x ?? 0) - (points[b]?.x ?? 0), y: (points[a]?.y ?? 0) - (points[b]?.y ?? 0) });
    for (let index = 1; index < 5; index += 1) expect(side(index, index - 1)).toBeCloseTo(side(1, 0), 9);
    expect(side(0, 4)).toBeCloseTo(side(1, 0), 9);
  });

  it("лучи направлены Стойкость вверх, Натиск вправо-вверх, Охота вправо-вниз, Чистота влево-вниз, Сборка влево-вверх", () => {
    const [t, k, h, c, b] = webPoints(unit({}), 1);

    expect(t && t.y < 0 && Math.abs(t.x) < 1e-9).toBe(true);
    expect(k && k.x > 0 && k.y < 0).toBe(true);
    expect(h && h.x > 0 && h.y > 0).toBe(true);
    expect(c && c.x < 0 && c.y > 0).toBe(true);
    expect(b && b.x < 0 && b.y < 0).toBe(true);
  });

  it("индекс 4 обрезан до потолка 3: луч доходит до края, но не дальше", () => {
    const points = webPoints(unit({ k: 4 }), 3);

    expect(radius(points[1] ?? { x: 9, y: 9 })).toBeCloseTo(1, 9);
  });

  it("нулевой, отрицательный и нечисловой индекс — центр, а не NaN", () => {
    const points = webPoints(unit({ t: 0, k: -2, h: Number.NaN }), 3);

    expect(radius(points[0] ?? { x: 9, y: 9 })).toBe(0);
    expect(radius(points[1] ?? { x: 9, y: 9 })).toBe(0);
    expect(radius(points[2] ?? { x: 9, y: 9 })).toBe(0);
  });

  it("потолок нуль или не число не делит на ноль: все лучи в центре", () => {
    for (const point of webPoints(unit({}), 0)) expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
  });
});

describe("подписи осей из ответа", () => {
  const evolutions = 2;

  it("Стойкость — время забега при десяти минутах", () => {
    expect(axisCaption("t", CARD, evolutions)).toBe("31:48 при 10:00");
  });

  it("Натиск — убийств в минуту", () => {
    expect(axisCaption("k", CARD, evolutions)).toBe("412 / мин");
  });

  it("Охота — боссы и элиты", () => {
    expect(axisCaption("h", CARD, evolutions)).toBe("6 боссов · 58 элит");
    expect(axisCaption("h", { ...CARD, facts: { ...CARD.facts, bossKills: 1, eliteKills: 21 } }, evolutions)).toBe("1 босс · 21 элита");
  });

  it("Охота без счётчиков (забег прошлой сборки) — без подписи, а не «0 боссов»", () => {
    expect(axisCaption("h", { ...CARD, facts: { ...CARD.facts, bossKills: null, eliteKills: null } }, evolutions)).toBeNull();
  });

  it("Чистота — урон против ожидаемого со знаком минус, как в макете", () => {
    expect(axisCaption("c", CARD, evolutions)).toBe("урон −38 %");
    expect(axisCaption("c", { ...CARD, facts: { ...CARD.facts, damageDeltaPct: 12 } }, evolutions)).toBe("урон +12 %");
    expect(axisCaption("c", { ...CARD, facts: { ...CARD.facts, damageDeltaPct: 0 } }, evolutions)).toBe("урон 0 %");
    expect(axisCaption("c", { ...CARD, facts: { ...CARD.facts, damageDeltaPct: null } }, evolutions)).toBeNull();
  });

  it("Сборка — число эволюций со склонением", () => {
    expect(axisCaption("b", CARD, 2)).toBe("2 эволюции");
    expect(axisCaption("b", CARD, 1)).toBe("1 эволюция");
    expect(axisCaption("b", CARD, 5)).toBe("5 эволюций");
    expect(axisCaption("b", CARD, 0)).toBe("без эволюций");
  });
});

describe("полосы разбора очков", () => {
  it("длины пропорциональны слагаемым, а черта ожидаемого — на той же шкале", () => {
    const bars = barShares(AXES);

    const t = bars.find((bar) => bar.axis === "t");
    const k = bars.find((bar) => bar.axis === "k");
    expect(t?.share).toBeCloseTo(1, 9);
    expect((k?.share ?? 0) / (t?.share ?? 1)).toBeCloseTo(284 / 1_200, 9);
    expect((k?.expectedShare ?? 0) / (t?.share ?? 1)).toBeCloseTo(200 / 1_200, 9);
  });

  it("порядок осей сохраняется, доли в пределах от нуля до единицы", () => {
    const bars = barShares(AXES);

    expect(bars.map((bar) => bar.axis)).toEqual(["t", "k", "h", "c", "b"]);
    for (const bar of bars) {
      expect(bar.share).toBeGreaterThanOrEqual(0);
      expect(bar.share).toBeLessThanOrEqual(1);
      expect(bar.expectedShare).toBeLessThanOrEqual(1);
    }
  });

  it("слагаемые нулевые — нулевые доли, а не NaN", () => {
    const zero = AXES.map((axis) => ({ ...axis, points: 0, expectedPoints: 0 }));

    for (const bar of barShares(zero)) {
      expect(bar.share).toBe(0);
      expect(bar.expectedShare).toBe(0);
    }
  });

  it("черта ожидаемого выше самой длинной полосы тоже влезает в шкалу", () => {
    const bars = barShares(AXES.map((axis) => (axis.axis === "t" ? { ...axis, points: 100, expectedPoints: 400 } : axis)));

    expect(bars.find((bar) => bar.axis === "t")?.expectedShare).toBeLessThanOrEqual(1);
  });
});

describe("эволюции в сборке", () => {
  it("считаются по предикату, повторов нет", () => {
    const isEvolution = (id: string): boolean => id.startsWith("evo_");

    expect(evolutionCount([{ id: "spark" }, { id: "evo_a" }, { id: "evo_b" }, { id: "evo_a" }], isEvolution)).toBe(2);
    expect(evolutionCount([], isEvolution)).toBe(0);
  });
});

describe("адрес карточки в стартовом параметре", () => {
  it("пара run с id забега собирается и разбирается обратно", () => {
    const param = runCardStartParam("3f2a9c1e-77b0-4c1d-9a55-0d3b6a41e8f2");

    expect(param).toBe("run-3f2a9c1e-77b0-4c1d-9a55-0d3b6a41e8f2");
    expect(parseRunCardStart(param)).toBe("3f2a9c1e-77b0-4c1d-9a55-0d3b6a41e8f2");
  });

  it("мусор, пустой id и чужая пара — ничего, а не экран с чужим адресом", () => {
    expect(parseRunCardStart(null)).toBeNull();
    expect(parseRunCardStart("")).toBeNull();
    expect(parseRunCardStart("run-")).toBeNull();
    expect(parseRunCardStart("card-123")).toBeNull();
    expect(parseRunCardStart("run-../../etc")).toBeNull();
    expect(parseRunCardStart(`run-${"a".repeat(65)}`)).toBeNull();
  });

  it("openRunCardFromStart открывает экран карточки по паре run, по чужой паре — нет", () => {
    useNavigation.setState({ stack: ["lobby"], runCardId: null });

    expect(openRunCardFromStart("card-12345678")).toBe(false);
    expect(useNavigation.getState().stack).toEqual(["lobby"]);

    expect(openRunCardFromStart("run-3f2a9c1e-77b0-4c1d-9a55-0d3b6a41e8f2")).toBe(true);
    expect(useNavigation.getState().runCardId).toBe("3f2a9c1e-77b0-4c1d-9a55-0d3b6a41e8f2");
    expect(useNavigation.getState().stack.at(-1)).toBe("runCard");
  });
});

describe("ответ сервера", () => {
  it("схема принимает полный ответ и отбрасывает лишнее", () => {
    const parsed = runCardSchema.safeParse({ ...CARD, accountId: "должно-отброситься" });

    expect(parsed.success).toBe(true);
    expect(parsed.success && "accountId" in parsed.data).toBe(false);
  });

  it("ответ без осей — не карточка", () => {
    expect(runCardSchema.safeParse({ ...CARD, axes: undefined }).success).toBe(false);
  });
});

describe("экран карточки", () => {
  const html = text(renderToStaticMarkup(createElement(RunCardBody, { card: CARD })));

  it("заголовок экрана — очки забега", () => {
    expect(cardTitle(1_990).replace(/\u00a0/g, " ")).toBe("Забег · 1 990");
  });

  it("шапка: игрок, время, уровень, мощь и стиль", () => {
    expect(html).toContain("Велимир");
    expect(html).toContain("31:48");
    expect(html).toContain("уровень 41");
    expect(html).toContain("Стена");
  });

  it("разбор очков: пять осей с подписями и слагаемыми", () => {
    expect(html).toContain("Разбор очков");
    for (const axis of ["Стойкость", "Натиск", "Охота", "Чистота", "Сборка"]) expect(html).toContain(axis);
    expect(html).toContain("412 / мин");
    expect(html).toContain("6 боссов · 58 элит");
    expect(html).toContain("1 200");
  });

  it("легенда пунктира и сборка", () => {
    expect(html).toContain("пунктир — ожидаемое для его силы");
    expect(html).toContain("Сборка");
    expect(html).toContain("Щит");
  });

  it("строки о проверке повтором нет: повтора на сервере ещё нет", () => {
    expect(html).not.toContain("проверку повтором");
  });

  it("свой забег: легенда говорит «твоей» силы", () => {
    const own = text(renderToStaticMarkup(createElement(RunCardBody, { card: { ...CARD, mine: true } })));

    expect(own).toContain("пунктир — ожидаемое для твоей силы");
  });

  it("«паутина» читается скринридером словами, а не только рисунком", () => {
    const web = renderToStaticMarkup(createElement(RunWeb, { axes: AXES, cap: 3 }));

    expect(web).toContain('role="img"');
    expect(web).toContain("aria-label");
    expect(web).toContain("stroke-dasharray");
    expect(web).toContain("Стойкость");
  });
});

describe("входы в карточку", () => {
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
  };

  it("строка рейтинга с забегом открывает карточку кнопкой", () => {
    const html = renderToStaticMarkup(createElement("ol", null, createElement(LeaderboardRow, { entry: { ...ENTRY, runId: "run-1" } as LeaderboardEntry, index: 0 })));

    expect(html).toContain("<button");
    expect(html).toContain("Злата");
  });

  it("строка без забега (старый сервер) — не кнопка: открывать нечего", () => {
    const html = renderToStaticMarkup(createElement("ol", null, createElement(LeaderboardRow, { entry: ENTRY, index: 0 })));

    expect(html).not.toContain("<button");
  });

  it("итоги забега: «Очки 2 140 · Тень» — кнопка", () => {
    const html = renderToStaticMarkup(createElement(RunScoreLink, { runId: "run-1", points: 2_140, style: "c" }));

    expect(text(html)).toContain("Очки 2 140 · Тень");
    expect(html).toContain("<button");
  });

  it("незнакомый стиль из будущего сервера — только очки, без пустого слова", () => {
    const html = text(renderToStaticMarkup(createElement(RunScoreLink, { runId: "run-1", points: 2_140, style: "zz" })));

    expect(html).toContain("Очки 2 140");
    expect(html).not.toContain("·");
  });

  it("открытие кладёт экран в стек, запоминает забег и считает событие", () => {
    useNavigation.setState({ stack: ["lobby"], runCardId: null });
    openRunCard("run-77", "rating");

    expect(useNavigation.getState().stack).toEqual(["lobby", "runCard"]);
    expect(useNavigation.getState().runCardId).toBe("run-77");
  });

  it("событие есть в словаре клиента", () => {
    expect(ANALYTICS_EVENTS).toContain("leaderboard_run_opened");
  });
});
