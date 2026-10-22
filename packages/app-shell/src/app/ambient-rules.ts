/**
 * Живой фон приложения (design/art/direction-v2.md §4.4): сумеречное небо со
 * звёздами и искры очага. Раскладка — золотым углом и остатками, без
 * случайности: фон одинаков на каждом запуске и на снимках.
 *
 * Мало и медленно: фон живой, но не зовёт глаз — внимание у кнопок.
 */
export const AMBIENT = { stars: 18, embers: 8 } as const;

export interface Star {
  /** положение в процентах экрана */
  x: number;
  y: number;
  /** диаметр, px */
  size: number;
  delaySec: number;
  durationSec: number;
}

export interface Ember {
  /** откуда поднимается, % ширины */
  x: number;
  /** снос вбок за подъём, px */
  drift: number;
  size: number;
  delaySec: number;
  durationSec: number;
}

const GOLDEN = 0.618033988749895;

export function starLayout(count: number): Star[] {
  return Array.from({ length: count }, (_, index) => {
    const x = ((index * GOLDEN) % 1) * 100;
    const y = ((index * 0.381966 + 0.13) % 1) * 58;
    return {
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      size: index % 5 === 0 ? 3 : 2,
      delaySec: (index * 0.7) % 5,
      durationSec: 3.5 + (index % 4) * 0.9,
    };
  });
}

export function emberLayout(count: number): Ember[] {
  return Array.from({ length: count }, (_, index) => ({
    x: Math.round((((index * GOLDEN + 0.07) % 1) * 90 + 5) * 10) / 10,
    drift: ((index % 3) - 1) * 18 + (index % 2 === 0 ? 6 : -6),
    size: index % 3 === 0 ? 4 : 3,
    delaySec: index * 1.7,
    durationSec: 9 + (index % 4) * 1.5,
  }));
}
