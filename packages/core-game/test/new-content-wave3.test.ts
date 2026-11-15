import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { ENDLESS_CURVE, TIMELINE } from "../src/content/waves";
import { findTimelineProblems } from "../src/game/sim/timeline-content";

// Новый контент Р157, третья волна (T-0283): Кикимора — исчезает и появляется рядом с игроком
// (паттерн `blink`). Числа стартовые, калибрует геймдизайнер.

describe("Кикимора", () => {
  const kikimora = ENEMIES.find((enemy) => enemy.id === "kikimora");

  it("исчезает и появляется рядом: паттерн blink, стойка к молнии и слаба к холоду", () => {
    expect(kikimora).toMatchObject({
      hp: 30,
      speed: 52,
      damage: 9,
      xp: 6,
      threat: 6,
      pattern: "blink",
      resist: { lightning: 0.5, cold: -0.4 },
    });
    // Параметры паттерна — умолчания движка: 4 с ходьбы, метка 0,6 с, появление в 90 от игрока.
    expect(kikimora?.params).toBeUndefined();
  });

  it("приходит отдельно коротким отрезком до кривой, потом входит в её пул последней", () => {
    const segment = TIMELINE.find((entry) => entry.spawns.some((spawn) => spawn.enemy === "kikimora"));
    expect(segment).toBeDefined();
    expect(segment?.fromSec).toBeLessThan(ENDLESS_CURVE.fromSec);
    expect(segment?.spawns.find((spawn) => spawn.enemy === "kikimora")).toMatchObject({ perSec: 0.3 });
    // Раньше отрезка Кикиморы её нет нигде: она показывается отдельно.
    for (const earlier of TIMELINE.filter((entry) => entry.fromSec < (segment?.fromSec ?? 0))) {
      expect(earlier.spawns.some((spawn) => spawn.enemy === "kikimora")).toBe(false);
    }
    expect(ENDLESS_CURVE.pool.at(-1)).toBe("kikimora");
  });

  it("бюджет угрозы отрезка не ниже предыдущего и не выше кривой", () => {
    expect(findTimelineProblems(TIMELINE, ENDLESS_CURVE, ENEMIES)).toEqual([]);
  });

  it("единственный враг паттерна blink", () => {
    expect(ENEMIES.filter((enemy) => enemy.pattern === "blink").map((enemy) => enemy.id)).toEqual(["kikimora"]);
  });
});
