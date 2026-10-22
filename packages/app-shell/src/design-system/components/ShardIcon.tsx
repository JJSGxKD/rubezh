import type { ReactNode } from "react";
import { shardColor } from "./shard-tones";

export { shardRarity, shardTone } from "./shard-tones";

/**
 * Осколок снаряжения — один значок на всю игру: награда дня, колесо,
 * задания, магазин, арсенал, история. Кристалл-скол с гранями, цвет —
 * редкость осколка, те же тона, что у редкости предмета в арсенале: осколок
 * и предмет, на который он идёт, читаются одним цветом. Тёмный контур — как
 * у монеты и самоцвета (design/art/direction-v2.md §7.2): в горсти наград
 * значки не сливаются.
 *
 * Отдельным модулем, а не рядом с монетой и самоцветом: тех ждёт шапка в
 * первой загрузке, осколки — только экраны по требованию
 * (docs/27-design-system-and-app-shell.md §3.4).
 */

/** Незнакомая редкость от сервера новее клиента — нейтральным тоном, а не пустым местом. */
export function ShardIcon(props: { rarity: string; size?: number }): ReactNode {
  const size = props.size ?? 18;
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" style={{ color: shardColor(props.rarity) }}>
      <path d="M20 2L31 13L27 38H13L9 13Z" fill="var(--color-ink)" stroke="var(--color-ink)" strokeWidth="4" strokeLinejoin="round" />
      <path d="M20 2L31 13L27 38H13L9 13Z" fill="currentColor" />
      <path d="M20 2L9 13L13 38L20 29Z" fill="#fff" fillOpacity="0.3" />
      <path d="M20 2L31 13L27 38L20 29Z" fill="#000" fillOpacity="0.22" />
      <path d="M20 2L24 9L20 14L16 9Z" fill="#fff" fillOpacity="0.5" />
    </svg>
  );
}
