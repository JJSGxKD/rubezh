import { describe, expect, it } from "vitest";
import { WORLD_COLORS } from "../src/game/render/looks";

// Угроза врага читается цветом (docs/35-stage4-plan.md, Р57): всё, что грозит
// игроку, — красное, а жёлтый и тёплые тона — за игроком. Полоса рывка волка
// однажды была жёлтой, как снаряды игрока, и угрозу было не отличить.

function channels(color: number): { r: number; g: number; b: number } {
  return { r: (color >> 16) & 0xff, g: (color >> 8) & 0xff, b: color & 0xff };
}

/** Красное: красный канал заметно сильнее зелёного и синего. */
function isRed(color: number): boolean {
  const { r, g, b } = channels(color);
  return r >= 0xd0 && r - g >= 0x60 && r - b >= 0x60;
}

describe("цвета угроз", () => {
  it("телеграфы и снаряды врагов — красные", () => {
    expect(isRed(WORLD_COLORS.threat)).toBe(true);
    expect(isRed(WORLD_COLORS.enemyProjectile)).toBe(true);
  });

  it("снаряды игрока и опыт угрозу не напоминают", () => {
    expect(isRed(WORLD_COLORS.projectile)).toBe(false);
  });

  it("свой опыт и обереги красными не бывают: угроза и добыча не совпадают по цвету", () => {
    expect(isRed(WORLD_COLORS.xpRing)).toBe(false);
    expect(isRed(WORLD_COLORS.orbiter)).toBe(false);
    expect(isRed(WORLD_COLORS.threat)).toBe(true);
  });

  it("отдельного жёлтого цвета полосы рывка больше нет", () => {
    expect("dashLane" in WORLD_COLORS).toBe(false);
  });
});
