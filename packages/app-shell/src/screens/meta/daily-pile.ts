/**
 * Горсть монет награды дня (design/art/ui-ux.md, U-12): рост награды по
 * неделе — вещью, а не только числом. Размер горсти — место дня среди наград
 * недели, а не сумма: расписание правят в панели, и горсть не должна
 * упираться в потолок от любой правки чисел.
 */

/** Больше пяти монет в плитку 44 px не помещается так, чтобы читалась каждая. */
export const COIN_PILE_MAX = 5;

/** Сколько монет в горсти дня: от одной у самого скромного дня до полной у самого щедрого. */
export function coinPile(coins: number, week: readonly number[]): number {
  if (week.length === 0) return 1;
  const min = Math.min(...week);
  const max = Math.max(...week);
  if (max <= min) return 1;
  return 1 + Math.round(((coins - min) / (max - min)) * (COIN_PILE_MAX - 1));
}

/**
 * Где лежат монеты горсти: сдвиг от центра плитки в px, по порядку
 * отрисовки — нижний ряд первым, верхние монеты ложатся поверх.
 */
export const PILE_SPOTS: readonly (readonly (readonly [number, number])[])[] = [
  [[0, 0]],
  [
    [-6, 3],
    [6, -1],
  ],
  [
    [-8, 4],
    [8, 4],
    [0, -5],
  ],
  [
    [-9, 5],
    [0, 6],
    [9, 5],
    [0, -5],
  ],
  [
    [-12, 5],
    [-2, 6],
    [9, 5],
    [-6, -4],
    [5, -5],
  ],
];

/** Выброс монет при заборе: сколько монет и сколько летит каждая, мс. */
export const COIN_BURST = { coins: 10, flyMs: 800 } as const;

export interface BurstCoin {
  /** куда долетает монета, px от центра плитки */
  x: number;
  y: number;
  delayMs: number;
}

/**
 * Веер монет вверх из плитки дня: от −150° до −30°, дальность чередуется,
 * чтобы монеты не легли дугой. Без случайности — одинаково при каждом заборе
 * и на снимках.
 */
export function burstVectors(count: number): BurstCoin[] {
  return Array.from({ length: count }, (_, index) => {
    const t = count === 1 ? 0.5 : index / (count - 1);
    const angle = ((-150 + t * 120) * Math.PI) / 180;
    const reach = 70 + ((index * 29) % 50);
    return { x: Math.round(Math.cos(angle) * reach), y: Math.round(Math.sin(angle) * reach), delayMs: (index % 3) * 45 };
  });
}
