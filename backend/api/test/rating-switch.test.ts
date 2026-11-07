import { describe, expect, it } from "vitest";
import { boardKeyOf, pointsFromOf, scoreOf, scoringOfSeason, thresholdOf } from "../src/modules/rating/rating-switch.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { rewardFor, seasonOf, type PrizeRules, type SeasonResultLine } from "../src/modules/seasons/season-rules.js";
import { SeasonSchedule } from "../src/modules/seasons/seasons-schedule.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Переход рейтинга с времени на очки (tasks/T-0294): чистые правила выбора
 * режима, порог награды сезона в очках и расписание сезонов по настройке
 * `rating.points-from`. Доски на живых хранилищах — `rating-boards.integration.test.ts`.
 */

const MONDAY = new Date("2026-11-09T00:00:00Z");

describe("pointsFromOf: настройка rating.points-from", () => {
  it("ноль, не дата и не понедельник — сезонов по очкам нет", () => {
    expect(pointsFromOf(0)).toBeNull();
    expect(pointsFromOf(20261110)).toBeNull(); // вторник
    expect(pointsFromOf(20261340)).toBeNull();
    expect(pointsFromOf(-20261109)).toBeNull();
    expect(pointsFromOf(1.5)).toBeNull();
  });

  it("понедельник ГГГГММДД — начало первого сезона по очкам", () => {
    expect(pointsFromOf(20261109)?.toISOString()).toBe(MONDAY.toISOString());
  });
});

describe("scoringOfSeason: какой сезон по очкам, какой по времени", () => {
  it("сезон, идущий в момент выката, дотягивается по времени, следующий — по очкам", () => {
    const from = pointsFromOf(20261109);
    expect(scoringOfSeason(seasonOf(new Date("2026-11-04T12:00:00Z")).startsAt, from)).toBe("time");
    expect(scoringOfSeason(seasonOf(new Date("2026-11-09T00:00:00Z")).startsAt, from)).toBe("points");
    expect(scoringOfSeason(seasonOf(new Date("2026-11-20T12:00:00Z")).startsAt, from)).toBe("points");
  });

  it("настройки нет — все сезоны по времени", () => {
    expect(scoringOfSeason(MONDAY, null)).toBe("time");
  });
});

describe("boardKeyOf: ключ доски сезона в Redis", () => {
  it("по времени — прежний ключ сезона, по очкам — с приставкой pts:", () => {
    expect(boardKeyOf("2026-11-09", "time")).toBe("2026-11-09");
    expect(boardKeyOf("2026-11-09", "points")).toBe("pts:2026-11-09");
  });
});

describe("scoreOf: число, по которому забег стоит в доске", () => {
  it("по времени — секунды, по очкам — очки; забег без очков в доске по очкам не стоит", () => {
    expect(scoreOf({ survivalSec: 900, points: 1800 }, "time")).toBe(900);
    expect(scoreOf({ survivalSec: 900, points: 1800 }, "points")).toBe(1800);
    expect(scoreOf({ survivalSec: 900, points: null }, "points")).toBeNull();
    expect(scoreOf({ survivalSec: 900 }, "points")).toBeNull();
  });

  it("ноль очков — это ноль, а не отсутствие", () => {
    expect(scoreOf({ survivalSec: 5, points: 0 }, "points")).toBe(0);
  });
});

describe("thresholdOf", () => {
  it("секунды в сезоне по времени, очки — по очкам", () => {
    expect(thresholdOf("time", 90, 800)).toBe(90);
    expect(thresholdOf("points", 90, 800)).toBe(800);
  });
});

describe("порог награды участника в очках", () => {
  const rules: PrizeRules = { scoring: "points", thresholdPoints: 800 };
  const line = (bestSec: number): SeasonResultLine => ({ difficulty: "hard", bestSec, place: 40, boardSize: 5 });

  it("799 очков — награды участника нет, 800 — есть", () => {
    expect(rewardFor([line(799)], rules)).toBeNull();
    expect(rewardFor([line(800)], rules)?.kind).toBe("threshold");
  });

  it("лестница мест прежняя: место в таблице из десяти награждается при любом числе очков", () => {
    const prize = rewardFor([{ difficulty: "hard", bestSec: 100, place: 1, boardSize: 10 }], rules);
    expect(prize?.kind).toBe("place");
    expect(prize?.place).toBe(1);
  });

  it("без правил порог прежний — секунды по сложности", () => {
    expect(rewardFor([{ difficulty: "hard", bestSec: 90, place: 40, boardSize: 5 }])?.kind).toBe("threshold");
    expect(rewardFor([{ difficulty: "hard", bestSec: 89.9, place: 40, boardSize: 5 }])).toBeNull();
  });
});

describe("ключи панели rating.points-from и rating.season-threshold-points", () => {
  it("есть в каталоге; по умолчанию сезонов по очкам нет, порог — 800", () => {
    expect(SETTINGS.ratingPointsFrom.key).toBe("rating.points-from");
    expect(SETTINGS.ratingPointsFrom.fallback).toBe(0);
    expect(SETTINGS.ratingSeasonThresholdPoints.key).toBe("rating.season-threshold-points");
    expect(SETTINGS.ratingSeasonThresholdPoints.fallback).toBe(800);
  });

  it("схема принимает ноль и понедельник, отклоняет другие дни", () => {
    expect(SETTINGS.ratingPointsFrom.schema.safeParse(0).success).toBe(true);
    expect(SETTINGS.ratingPointsFrom.schema.safeParse(20261109).success).toBe(true);
    expect(SETTINGS.ratingPointsFrom.schema.safeParse(20261110).success).toBe(false);
  });

  it("менять правила идущей недели нельзя: дата не раньше следующей недели", () => {
    const check = SETTINGS.ratingPointsFrom.saveCheck;
    const wednesday = new Date("2026-11-04T12:00:00Z");
    expect(check?.(20261102, wednesday)).not.toBeNull();
    expect(check?.(20261109, wednesday)).toBeNull();
    expect(check?.(0, wednesday)).toBeNull();
  });
});

describe("SeasonSchedule: режим сезона по настройке", () => {
  const SETTING_KEY = "rating.points-from";

  it("сезон до даты — по времени и под прежним ключом, после — по очкам и под ключом pts:", () => {
    const schedule = new SeasonSchedule(panelSettings({ [SETTING_KEY]: 20261109 }));
    const running = seasonOf(new Date("2026-11-04T12:00:00Z"));
    const next = seasonOf(new Date("2026-11-10T12:00:00Z"));

    expect(schedule.scoringOf(running)).toBe("time");
    expect(schedule.boardSeason(running).key).toBe("2026-11-02");
    expect(schedule.scoringOf(next)).toBe("points");
    expect(schedule.boardSeason(next).key).toBe("pts:2026-11-09");
    // Доска хранит и срок жизни ключа: он считается от конца той же недели.
    expect(schedule.boardSeason(next).endsAt.getTime()).toBe(next.endsAt.getTime());
  });

  it("настройки нет — все сезоны по времени; порог очков берётся из панели", () => {
    const schedule = new SeasonSchedule(panelSettings());
    expect(schedule.scoringOf(seasonOf(new Date("2026-11-10T12:00:00Z")))).toBe("time");
    expect(schedule.thresholdPoints()).toBe(800);
    expect(new SeasonSchedule(panelSettings({ "rating.season-threshold-points": 1200 })).thresholdPoints()).toBe(1200);
  });

  it("правка из панели действует сразу: пересчёт на каждый вызов", () => {
    const settings = panelSettings();
    const schedule = new SeasonSchedule(settings);
    const next = seasonOf(new Date("2026-11-10T12:00:00Z"));
    expect(schedule.scoringOf(next)).toBe("time");

    settings.set(SETTING_KEY, 20261109);

    expect(schedule.scoringOf(next)).toBe("points");
  });
});
