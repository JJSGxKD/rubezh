import { describe, expect, it } from "vitest";
import { EVENT_DICTIONARY } from "../../../backend/api/src/modules/events/event-dictionary.js";
import { ANALYTICS_EVENTS } from "../src/state/analytics";

// Событие `evolution_unlocked` (tasks/T-0102, docs/22 §3.3): сундук выдал
// эволюцию. Схема — в словаре сервера, имя — в списке клиента.

const FULL = { evolution: "starfall", weapon: "spark", passive: "haste", chest: 0, level: 9, elapsedSec: 301 };

describe("событие evolution_unlocked", () => {
  it("клиент его знает", () => {
    expect(ANALYTICS_EVENTS).toContain("evolution_unlocked");
  });

  const { payload } = EVENT_DICTIONARY.evolution_unlocked;

  it("полный набор полей проходит схему", () => {
    expect(payload.safeParse(FULL).success).toBe(true);
  });

  it("без обязательного поля — нет", () => {
    for (const key of Object.keys(FULL)) {
      const { [key as keyof typeof FULL]: _dropped, ...rest } = FULL;
      expect(payload.safeParse(rest).success, key).toBe(false);
    }
  });

  it("номер сундука отрицательный или дробный — нет", () => {
    expect(payload.safeParse({ ...FULL, chest: -1 }).success).toBe(false);
    expect(payload.safeParse({ ...FULL, chest: 0.5 }).success).toBe(false);
  });

  it("пустой id эволюции — нет", () => {
    expect(payload.safeParse({ ...FULL, evolution: "" }).success).toBe(false);
  });
});
