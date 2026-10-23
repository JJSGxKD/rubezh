import { COLORS } from "../../design-system/tokens";

/**
 * Цвета точек радара по виду. Аптечка зелёная, как подбор на земле: красная
 * сливалась с врагами на тесте (решение участника 1 от 13.10.2026). Форма
 * (крест, кольцо, ромб) задаётся в `Radar.tsx` и тоже отличает подборы.
 */
export const RADAR_COLORS = {
  enemy: COLORS.danger,
  elite: COLORS.elite,
  medkit: COLORS.success,
  magnet: COLORS.xp,
  dynamite: COLORS.warning,
  // Золото занято элитой и динамитом, зелёное — аптечкой, салатовое — магнитом:
  // сундук — фиолетовым токеном предметов, и квадратом, а не точкой или ромбом.
  chest: COLORS.passive,
} as const;

/**
 * Форма точки по виду: при дейтеранопии и протанопии красный враг и золотая
 * элита — одна жёлто-оливковая точка, поэтому вид обязан читаться формой.
 * Элита — точка с тёмной кромкой и светлым сердцем, рядовой — простая.
 */
export const RADAR_SHAPES = {
  enemy: "dot",
  elite: "marked",
  medkit: "cross",
  magnet: "ring",
  dynamite: "diamond",
  chest: "square",
} as const;
