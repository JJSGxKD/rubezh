import { describe, expect, it } from "vitest";
import { AMBIENT, emberLayout, starLayout } from "../src/app/ambient-rules";

// Живой фон приложения (design/art/direction-v2.md §4.4): звёзды мерцают,
// искры очага поднимаются. Раскладка без случайности — один и тот же фон на
// каждом запуске и на снимках; всё в пределах экрана.

describe("звёзды", () => {
  const stars = starLayout(AMBIENT.stars);

  it("нужное число, в пределах экрана, в верхней половине неба", () => {
    expect(stars).toHaveLength(AMBIENT.stars);
    for (const star of stars) {
      expect(star.x).toBeGreaterThanOrEqual(0);
      expect(star.x).toBeLessThanOrEqual(100);
      expect(star.y).toBeGreaterThanOrEqual(0);
      expect(star.y).toBeLessThanOrEqual(60);
    }
  });

  it("мерцают не в такт и одинаково при каждом запуске", () => {
    expect(new Set(stars.map((star) => star.delaySec)).size).toBeGreaterThan(3);
    expect(starLayout(AMBIENT.stars)).toEqual(stars);
  });
});

describe("искры", () => {
  const embers = emberLayout(AMBIENT.embers);

  it("поднимаются медленно: каждая дольше восьми секунд", () => {
    expect(embers).toHaveLength(AMBIENT.embers);
    for (const ember of embers) {
      expect(ember.durationSec).toBeGreaterThanOrEqual(8);
      expect(ember.x).toBeGreaterThanOrEqual(0);
      expect(ember.x).toBeLessThanOrEqual(100);
    }
  });

  it("не вылетают пачкой: задержки разные", () => {
    expect(new Set(embers.map((ember) => ember.delaySec)).size).toBe(embers.length);
  });
});
