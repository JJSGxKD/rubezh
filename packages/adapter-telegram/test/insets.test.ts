import { describe, expect, it } from "vitest";
import { sameInsets, sumInsets } from "../src/insets";

// Отступы безопасной зоны (docs/27-design-system-and-app-shell.md §5.1).
// Проверяется арифметика, а не вёрстка: именно она решает, окажется ли кнопка
// под вырезом камеры.

const ZERO = { top: 0, right: 0, bottom: 0, left: 0 };

describe("отступы безопасной зоны", () => {
  it("складывает системную зону и зону кнопок площадки", () => {
    const insets = sumInsets(
      { top: 44, right: 0, bottom: 34, left: 0 },
      { top: 56, right: 0, bottom: 0, left: 0 },
    );

    // Верх — вырез плюс кнопки Telegram поверх приложения в fullscreen.
    expect(insets.top).toBe(100);
    expect(insets.bottom).toBe(34);
  });

  it("не даёт отрицательным и нечисловым значениям сдвинуть интерфейс под вырез", () => {
    const broken = { top: -20, right: Number.NaN, bottom: Number.POSITIVE_INFINITY, left: 12 };
    const insets = sumInsets(broken, ZERO);

    expect(insets).toEqual({ top: 0, right: 0, bottom: 0, left: 12 });
  });

  it("считает одинаковыми отступы с теми же числами — иначе подписка сработает вхолостую", () => {
    expect(sameInsets(ZERO, { ...ZERO })).toBe(true);
    expect(sameInsets(ZERO, { ...ZERO, top: 1 })).toBe(false);
  });
});
