import { describe, expect, it } from "vitest";
import { CHEST_AURA_FADE_TICKS, chestAura } from "../src/game/render/pickups";

// Ореол сундука на земле (design/art/effects.md §6.2): сияние и столб света
// зовут к награде. Рендер, на исход забега не влияет, но числа должны быть
// ограничены: ореол не должен ни пропадать, ни слепить.

describe("ореол сундука", () => {
  it("проявляется после приземления, а не вспыхивает сразу", () => {
    expect(chestAura(0, 0, 0).alpha).toBe(0);
    expect(chestAura(CHEST_AURA_FADE_TICKS / 2, 0, 0).alpha).toBeGreaterThan(0);
    expect(chestAura(CHEST_AURA_FADE_TICKS / 2, 0, 0).alpha).toBeLessThan(chestAura(CHEST_AURA_FADE_TICKS, 0, 0).alpha);
  });

  it("дышит в пределах: виден всегда и не слепит", () => {
    for (let tick = 0; tick < 200; tick++) {
      const aura = chestAura(1000, tick, 0);
      expect(aura.alpha).toBeGreaterThanOrEqual(0.45);
      expect(aura.alpha).toBeLessThanOrEqual(0.85);
      expect(aura.beamAlpha).toBeGreaterThan(0.2);
      expect(aura.beamAlpha).toBeLessThanOrEqual(0.7);
      expect(aura.glowScale).toBeGreaterThanOrEqual(1);
      expect(aura.glowScale).toBeLessThanOrEqual(1.2);
    }
  });

  it("два сундука рядом дышат не в такт", () => {
    expect(chestAura(1000, 10, 0)).not.toEqual(chestAura(1000, 10, 1));
  });
});
