/**
 * Выброс при заборе награды (design/art/ui-ux.md, U-16): забор — событие, а
 * не строка текста. Числа — здесь, рисует `reward-burst.tsx`.
 */
/** Выброс при заборе награды: сколько значков и сколько летит каждый, мс. */
export const COIN_BURST = { coins: 10, flyMs: 800 } as const;

export interface BurstCoin {
  /** куда долетает значок, px от центра места награды */
  x: number;
  y: number;
  delayMs: number;
}

/**
 * Веер вверх из места награды: от −150° до −30°, дальность чередуется, чтобы
 * значки не легли дугой. Без случайности — одинаково при каждом заборе и на
 * снимках.
 */
export function burstVectors(count: number): BurstCoin[] {
  return Array.from({ length: count }, (_, index) => {
    const t = count === 1 ? 0.5 : index / (count - 1);
    const angle = ((-150 + t * 120) * Math.PI) / 180;
    const reach = 70 + ((index * 29) % 50);
    return { x: Math.round(Math.cos(angle) * reach), y: Math.round(Math.sin(angle) * reach), delayMs: (index % 3) * 45 };
  });
}

export type BurstIcon = "coin" | "gem" | "shard";

/**
 * Чем выстреливает награда из нескольких валют — самым ценным, что в ней
 * есть: самоцвет за звёзды, монета за игру, осколок — добавка к ним.
 */
export function mainResource(reward: { coins: number; gems: number; shards: number }): { icon: BurstIcon; amount: number } | null {
  if (reward.gems > 0) return { icon: "gem", amount: reward.gems };
  if (reward.coins > 0) return { icon: "coin", amount: reward.coins };
  if (reward.shards > 0) return { icon: "shard", amount: reward.shards };
  return null;
}
