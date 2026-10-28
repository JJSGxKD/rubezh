import type { EnemyPattern } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { ENEMY_LOOKS, enemyColor, enemyRim, GEM_TIERS, PICKUP_LOOKS, WORLD_COLORS } from "../src/game/render/looks";
import { PICKUP_KIND } from "../src/game/sim/pickups";

// Облик боя «Сумеречный рубеж» (design/README.md, «Вид боя»; tasks/T-0014):
// враги красные и различаются формой, опасное — каймой, кристаллы яркие.

const PATTERNS = Object.keys(ENEMY_LOOKS) as EnemyPattern[];

function hsv(color: number): { h: number; s: number; v: number } {
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max === 0 ? 0 : delta / max, v: max };
}

function lightness(color: number): number {
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
}

describe("враги в красной гамме", () => {
  it("оттенок каждого — от 330° до 20°, насыщенность не ниже 0,45", () => {
    for (const pattern of PATTERNS) {
      const { h, s } = hsv(ENEMY_LOOKS[pattern].color);
      expect(h >= 330 || h <= 20, `${pattern}: оттенок ${String(Math.round(h))}°`).toBe(true);
      expect(s, `${pattern}: насыщенность`).toBeGreaterThanOrEqual(0.45);
    }
  });

  it("формы у всех поведений разные: главное различие типа — форма, а не оттенок", () => {
    const shapes = PATTERNS.map((pattern) => ENEMY_LOOKS[pattern].shape);
    expect(new Set(shapes).size).toBe(PATTERNS.length);
    expect(PATTERNS).toHaveLength(8);
  });
});

describe("кольцо стражей", () => {
  it("у паттерна cordon есть облик: форма и цвет", () => {
    expect(ENEMY_LOOKS.cordon).toEqual({ shape: "diamond", color: 0xb3203f });
  });
});

describe("цвет ранга", () => {
  it("элита отличается от рядового у каждого поведения", () => {
    for (const pattern of PATTERNS) {
      expect(enemyColor(pattern, "elite"), pattern).not.toBe(enemyColor(pattern, undefined));
    }
  });

  it("босс отличается от рядового и от элиты — и у chase тоже", () => {
    // Цвет смешения босса — #ff4f8f, а не цвет chase (#e0245e): иначе его босс не отличался бы от рядового.
    for (const pattern of PATTERNS) {
      expect(enemyColor(pattern, "boss"), pattern).not.toBe(enemyColor(pattern, undefined));
      expect(enemyColor(pattern, "boss"), pattern).not.toBe(enemyColor(pattern, "elite"));
    }
    expect(enemyColor("chase", "boss")).toBe(0xec3572);
  });

  it("рядовой — это цвет из таблицы без смешения", () => {
    expect(enemyColor("swarm", undefined)).toBe(0xff4d5a);
  });

  it("элита — смешение с жаром очага на 35 %", () => {
    // 0xff4d5a → 0xff8f3f: r = 255, g = 77 + (143 − 77) · 0,35 = 100, b = 90 + (63 − 90) · 0,35 = 81
    expect(enemyColor("swarm", "elite")).toBe((255 << 16) | (100 << 8) | 81);
  });

  it("босс — смешение с ярко-малиновым на 40 %", () => {
    // 0xff4d5a → 0xff4f8f: r = 255, g = 77 + (79 − 77) · 0,4 = 78, b = 90 + (143 − 90) · 0,4 = 111
    expect(enemyColor("swarm", "boss")).toBe((255 << 16) | (78 << 8) | 111);
  });

  it("кайма: у рядового нет, у элиты 2, у босса 3, золотая", () => {
    expect(enemyRim(undefined)).toBeNull();
    expect(enemyRim("elite")).toEqual({ color: 0xffd15c, width: 2 });
    expect(enemyRim("boss")).toEqual({ color: 0xffd15c, width: 3 });
  });
});

describe("красная гамма и у рангов", () => {
  it("тело элиты и босса остаётся в красной гамме: оттенок 330°–20°", () => {
    for (const pattern of PATTERNS) {
      for (const rank of ["elite", "boss"] as const) {
        const { h } = hsv(enemyColor(pattern, rank));
        expect(h >= 330 || h <= 20, `${pattern}/${rank}: оттенок ${String(Math.round(h))}°`).toBe(true);
      }
    }
  });
});

describe("кристаллы и мир", () => {
  it("кристаллы яркие: светлота по HSL не ниже 0,6", () => {
    for (const tier of GEM_TIERS) {
      expect(lightness(tier.color), `ступень ${String(tier.minValue)}`).toBeGreaterThanOrEqual(0.6);
    }
  });

  it("цвета ступеней кристаллов попарно различаются", () => {
    expect(new Set(GEM_TIERS.map((tier) => tier.color)).size).toBe(GEM_TIERS.length);
  });

  it("цвета кристаллов по таблице", () => {
    expect(GEM_TIERS.map((tier) => tier.color)).toEqual([0xb6ff4a, 0xa8f4ff, 0xd68cff, 0xffd15c]);
  });

  it("обереги бирюзовые, как secondary палитры", () => {
    expect(WORLD_COLORS.orbiter).toBe(0x46d9c6);
  });

  it("земля, здоровье, опыт и лечение — по таблице", () => {
    expect(WORLD_COLORS.ground).toBe(0x2b4152);
    expect(WORLD_COLORS.groundLine).toBe(0x33495b);
    expect(WORLD_COLORS.playerEdge).toBe(0x1d1c31);
    expect([WORLD_COLORS.hpFull, WORLD_COLORS.hpMid, WORLD_COLORS.hpLow]).toEqual([0xff6f90, 0xffc14d, 0xff3b5c]);
    expect(WORLD_COLORS.xpRing).toBe(0xb6ff4a);
    expect(WORLD_COLORS.heal).toBe(0x8ee86b);
  });
});

describe("облик подборов", () => {
  it("у каждого вида подбора есть облик, а сундуки различаются размером", () => {
    for (const [name, kind] of Object.entries(PICKUP_KIND)) {
      expect(PICKUP_LOOKS[kind], `подбор ${name}`).toBeDefined();
    }
    expect(PICKUP_LOOKS).toHaveLength(Object.keys(PICKUP_KIND).length);

    const [one, three, five] = [PICKUP_KIND.chestOne, PICKUP_KIND.chestThree, PICKUP_KIND.chestFive].map(
      (kind) => PICKUP_LOOKS[kind],
    );
    expect([one.id, three.id, five.id]).toEqual(["chest_one", "chest_three", "chest_five"]);
    expect(one.size).toBeLessThan(three.size);
    expect(three.size).toBeLessThan(five.size);
    expect(new Set([one.key, three.key, five.key]).size).toBe(3);
  });

  // Ореол сундука на земле — тон яруса окна вскрытия: размер сундука читается
  // издалека цветом света, а не только величиной коробки.
  it("у сундуков ореол своего тона, у прочих подборов ореола нет", () => {
    const auras = [PICKUP_KIND.chestOne, PICKUP_KIND.chestThree, PICKUP_KIND.chestFive].map((kind) => PICKUP_LOOKS[kind].aura);
    expect(auras.every((aura) => typeof aura === "number")).toBe(true);
    expect(new Set(auras).size).toBe(3);
    for (const kind of [PICKUP_KIND.medkit, PICKUP_KIND.magnet, PICKUP_KIND.dynamite, PICKUP_KIND.freeze]) {
      expect(PICKUP_LOOKS[kind].aura).toBeUndefined();
    }
  });

  it("у заморозки холодный облик крупнее аптечки, а оттенок замерших и волна — холодных тонов", () => {
    const look = PICKUP_LOOKS[PICKUP_KIND.freeze];
    expect(look.id).toBe("freeze");
    expect(look.size).toBe(1.25);
    expect(look.size).toBeGreaterThan(PICKUP_LOOKS[PICKUP_KIND.medkit].size);
    for (const color of [look.color, WORLD_COLORS.freezeWave, WORLD_COLORS.freezeTint]) {
      // Синяя половина круга: красный канал заметно слабее синего.
      expect((color >> 16) & 0xff, color.toString(16)).toBeLessThan(color & 0xff);
    }
  });

  it("ключи текстур подборов не повторяются", () => {
    const keys = PICKUP_LOOKS.map((look) => look.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
