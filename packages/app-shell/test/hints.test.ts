import { describe, expect, it } from "vitest";
import type { HudSnapshot } from "@bh/core-game";
import { currentHint, isHintDone } from "../src/state/hints";

// Подсказки первого забега гаснут по действию игрока, а не по таймеру.

const hud = (patch: Partial<HudSnapshot> = {}): HudSnapshot => ({
  survivalSec: 0,
  hp: 100,
  maxHp: 100,
  level: 1,
  xp: 0,
  xpToNext: 6,
  wave: 0,
  enemiesAlive: 0,
  enemiesKilled: 0,
  weapons: [],
  passives: [],
  distance: 0,
  radar: { blips: new Float32Array(0), count: 0 },
  boss: null,
  ...patch,
});

describe("подсказки первого забега", () => {
  it("идут по порядку и заканчиваются", () => {
    expect(currentHint([])).toBe("move");
    expect(currentHint(["move"])).toBe("gems");
    expect(currentHint(["move", "gems"])).toBe("dodge");
    expect(currentHint(["move", "gems", "dodge"])).toBeNull();
  });

  it("про движение — гаснет, когда игрок прошёл заметное расстояние, а не от случайного касания", () => {
    expect(isHintDone("move", hud({ distance: 20 }), 0)).toBe(false);
    expect(isHintDone("move", hud({ distance: 200 }), 0)).toBe(true);
  });

  it("про кристаллы — гаснет с первым опытом", () => {
    expect(isHintDone("gems", hud(), 0)).toBe(false);
    expect(isHintDone("gems", hud({ xp: 1 }), 0)).toBe(true);
    expect(isHintDone("gems", hud({ level: 2 }), 0)).toBe(true);
  });

  it("совет без действия держится несколько секунд забега с момента появления", () => {
    expect(isHintDone("dodge", hud({ survivalSec: 12 }), 10)).toBe(false);
    expect(isHintDone("dodge", hud({ survivalSec: 17 }), 10)).toBe(true);
  });
});
