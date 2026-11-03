import { describe, expect, it } from "vitest";
import { EVOLUTION_POWER_RATIO } from "../src/content/balance-targets";
import { ENEMIES } from "../src/content/enemies";
import { ACCOUNT_UNLOCKS } from "../src/content/unlocks";
import { ENDLESS_CURVE, TIMELINE } from "../src/content/waves";
import { WEAPONS } from "../src/content/weapons";
import { weaponPowerIndex } from "../src/game/progression/evolutions";
import { unlocksAt } from "../src/game/progression/unlocks";

// Новый контент Р157, первая волна (T-0281): Ледяной дух и Кистень с
// эволюцией «Круговерть». Числа стартовые, калибрует геймдизайнер.

describe("Ледяной дух", () => {
  const spirit = ENEMIES.find((enemy) => enemy.id === "ice_spirit");

  it("кружит широким кольцом и морозит касанием", () => {
    expect(spirit).toMatchObject({
      hp: 22,
      speed: 90,
      damage: 6,
      xp: 4,
      threat: 4,
      pattern: "orbit",
      element: "cold",
      statusChance: 0.35,
      resist: { cold: 0.5, fire: -0.5 },
      params: { orbitRadius: 150, shrinkPerSec: 10 },
    });
  });

  it("приходит отдельно в расписанном отрезке после 240 с, потом в смеси бесконечного режима", () => {
    const segment = TIMELINE.find((entry) => entry.fromSec > 240 && entry.spawns.some((spawn) => spawn.enemy === "ice_spirit"));
    expect(segment?.spawns.find((spawn) => spawn.enemy === "ice_spirit")).toMatchObject({ perSec: 0.5, burst: 4 });
    expect(ENDLESS_CURVE.pool).toContain("ice_spirit");
  });
});

describe("Кистень и «Круговерть»", () => {
  const flail = WEAPONS.find((weapon) => weapon.id === "flail");
  const whirl = WEAPONS.find((weapon) => weapon.id === "whirl");

  it("кистень — груз на орбите без стихии, пять уровней по возрастанию", () => {
    expect(flail?.behavior).toBe("orbit");
    expect(flail?.element).toBeUndefined();
    expect(flail?.levels).toHaveLength(5);
    expect(flail?.levels[0]).toMatchObject({ damage: 34, cooldownSec: 1.6, projectiles: 1, areaRadius: 72, projectileSpeed: 260 });
    expect(flail?.levels[4]).toMatchObject({ damage: 60, cooldownSec: 1.2, projectiles: 1, areaRadius: 88, projectileSpeed: 300 });
    const levels = flail?.levels ?? [];
    for (let i = 1; i < levels.length; i++) {
      const prev = levels[i - 1];
      const next = levels[i];
      expect(next?.damage, `уровень ${String(i + 1)}`).toBeGreaterThanOrEqual(prev?.damage ?? 0);
      const changed = next?.damage !== prev?.damage || next?.cooldownSec !== prev?.cooldownSec || next?.areaRadius !== prev?.areaRadius;
      expect(changed, `уровень ${String(i + 1)} ничем не отличается`).toBe(true);
    }
  });

  it("«Круговерть» — эволюция кистеня по «Мощи», один уровень, сила в коридоре", () => {
    expect(whirl).toMatchObject({ behavior: "orbit", evolvedFrom: "flail", recipe: { passive: "might" } });
    expect(whirl?.element).toBeUndefined();
    expect(whirl?.levels).toHaveLength(1);
    const top = flail?.levels.at(-1);
    const only = whirl?.levels[0];
    expect(top !== undefined && only !== undefined).toBe(true);
    if (top === undefined || only === undefined) return;
    const ratio = weaponPowerIndex(only) / weaponPowerIndex(top);
    expect(ratio).toBeGreaterThanOrEqual(EVOLUTION_POWER_RATIO.min);
    expect(ratio).toBeLessThanOrEqual(EVOLUTION_POWER_RATIO.max);
  });

  it("кистень открывается на 18-м уровне аккаунта, эволюция вместе с ним", () => {
    expect(unlocksAt(ACCOUNT_UNLOCKS, 17).weapons.has("flail")).toBe(false);
    expect(unlocksAt(ACCOUNT_UNLOCKS, 18).weapons.has("flail")).toBe(true);
    expect(unlocksAt(ACCOUNT_UNLOCKS, 18).weapons.has("whirl")).toBe(true);
  });
});
