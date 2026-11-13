import { describe, expect, it } from "vitest";
import { ENEMIES } from "../src/content/enemies";
import { ENDLESS_CURVE, TIMELINE } from "../src/content/waves";

// Новый контент Р157, вторая волна (T-0282): Болотник — преследует и оставляет
// ядовитые лужи. Числа стартовые, калибрует геймдизайнер.

describe("Болотник", () => {
  const lurker = ENEMIES.find((enemy) => enemy.id === "bog_lurker");

  it("преследует, травит ядом и оставляет лужи", () => {
    expect(lurker).toMatchObject({
      hp: 40,
      speed: 34,
      damage: 8,
      xp: 6,
      threat: 3.75,
      pattern: "chase",
      element: "poison",
      statusChance: 0.5,
      resist: { poison: 0.6, fire: -0.4 },
      trail: { everySec: 1.5, radius: 26, lifeSec: 4, damagePerSec: 5 },
    });
  });

  it("приходит отдельно в расписанном отрезке после 300 с, потом в смеси бесконечного режима", () => {
    const segment = TIMELINE.find((entry) => entry.fromSec > 300 && entry.spawns.some((spawn) => spawn.enemy === "bog_lurker"));
    expect(segment).toBeDefined();
    expect(segment?.fromSec).toBeLessThan(ENDLESS_CURVE.fromSec);
    expect(segment?.spawns.find((spawn) => spawn.enemy === "bog_lurker")).toMatchObject({ perSec: 0.4, burst: 3 });
    expect(ENDLESS_CURVE.pool).toContain("bog_lurker");
    // До этого отрезка Болотника нет нигде: он показывается отдельно.
    for (const earlier of TIMELINE.filter((entry) => entry.fromSec <= 300)) {
      expect(earlier.spawns.some((spawn) => spawn.enemy === "bog_lurker")).toBe(false);
    }
  });

  it("след — только у Болотника", () => {
    expect(ENEMIES.filter((enemy) => enemy.trail !== undefined).map((enemy) => enemy.id)).toEqual(["bog_lurker"]);
  });
});
