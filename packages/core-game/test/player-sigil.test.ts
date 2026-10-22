import { describe, expect, it } from "vitest";
import { ellipsePoints, hpArc, LEVEL_FLASH_TICKS, levelFlash } from "../src/game/render/player-sigil";

// Знак под ногами героя-спрайта (design/art/direction-v2.md §4.1): здоровье —
// дугой эллипса на земле, а не кольцами поверх тела. Дуга тает с тыльной
// стороны: остаток всегда спереди, под ногами, и спрайт его не закрывает.

const FRONT = Math.PI / 2;

describe("дуга здоровья", () => {
  it("полное здоровье — замкнутый эллипс", () => {
    const arc = hpArc(1);
    expect(arc).not.toBeNull();
    expect((arc?.end ?? 0) - (arc?.start ?? 0)).toBeCloseTo(Math.PI * 2, 6);
  });

  it("половина — передняя половина, симметрично вокруг передней точки", () => {
    const arc = hpArc(0.5);
    expect(arc?.start).toBeCloseTo(FRONT - Math.PI / 2, 6);
    expect(arc?.end).toBeCloseTo(FRONT + Math.PI / 2, 6);
  });

  it("пусто — дуги нет; лишнее за пределами 0…1 не ломает знак", () => {
    expect(hpArc(0)).toBeNull();
    expect(hpArc(-1)).toBeNull();
    expect((hpArc(3)?.end ?? 0) - (hpArc(3)?.start ?? 0)).toBeCloseTo(Math.PI * 2, 6);
  });
});

describe("точки эллипса", () => {
  it("столько точек, сколько отрезков плюс одна, и все на эллипсе", () => {
    const points = ellipsePoints(10, 20, 30, 10, 0, Math.PI, 12);
    expect(points).toHaveLength(13 * 2);
    for (let i = 0; i < points.length; i += 2) {
      const dx = ((points[i] ?? 0) - 10) / 30;
      const dy = ((points[i + 1] ?? 0) - 20) / 10;
      expect(dx * dx + dy * dy).toBeCloseTo(1, 6);
    }
    // Передняя точка — ниже центра: y экрана растёт вниз.
    const front = ellipsePoints(0, 0, 30, 10, FRONT, FRONT, 1);
    expect(front[1]).toBeCloseTo(10, 6);
  });
});

describe("вспышка нового уровня", () => {
  it("расходится и гаснет за своё время", () => {
    const start = levelFlash(0);
    const middle = levelFlash(LEVEL_FLASH_TICKS / 2);
    expect(start?.alpha).toBeGreaterThan(middle?.alpha ?? 1);
    expect(middle?.scale).toBeGreaterThan(start?.scale ?? 0);
    expect(levelFlash(LEVEL_FLASH_TICKS)).toBeNull();
    expect(levelFlash(-1)).toBeNull();
  });
});
