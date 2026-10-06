import { describe, expect, it } from "vitest";
import { projectileLook } from "../src/game/render/projectile-look";

// Вид снаряда: свой — круглый и без поворота, вражеский — вытянут по полёту
// (tasks/T-0005). Один объект `out` переиспользуется, поэтому свой снаряд
// обязан сбрасывать то, что оставил вражеский.

function look(): { texture: string; rotation: number; scaleX: number; scaleY: number } {
  return { texture: "", rotation: 0, scaleX: 1, scaleY: 1 };
}

describe("вид снаряда", () => {
  it("вражеский — своя текстура, поворот по скорости, вытянут 1,15 × 0,8", () => {
    const out = look();
    projectileLook(false, 0, 5, out);

    expect(out.texture).toBe("bh-projectile-enemy");
    expect(out.rotation).toBeCloseTo(Math.PI / 2, 12);
    expect(out.scaleX).toBe(1.15);
    expect(out.scaleY).toBe(0.8);
  });

  it("свой после вражеского в том же out — поворот 0 и масштаб 1 × 1", () => {
    const out = look();
    projectileLook(false, -3, 4, out);
    projectileLook(true, -3, 4, out);

    expect(out).toEqual({ texture: "bh-projectile", rotation: 0, scaleX: 1, scaleY: 1 });
  });
});
