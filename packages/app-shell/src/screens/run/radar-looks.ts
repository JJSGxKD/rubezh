import { COLORS } from "../../design-system/tokens";

/**
 * Цвета точек радара по виду. Аптечка зелёная, как подбор на земле: красная
 * сливалась с врагами на тесте (решение владельца от 13.10.2026). Форма
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
  // Тайники рубежа (Р153): холодная гамма оберегов — голубой токен — и Нави — фиолетовый токен предметов;
  // не красный, не золотой и не салатовый. Токена бирюзы нет, а вид читается формой (`RADAR_SHAPES`).
  shrine: COLORS.info,
  hoard: COLORS.info,
  tree: COLORS.info,
  wisp: COLORS.info,
  stone: COLORS.passive,
  rift: COLORS.passive,
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
  freeze: "x",
  // Тайник — не точка и не подбор: знак вида, как круг со знаком на земле. Огонёк — звёздочка из точек.
  shrine: "pillar",
  hoard: "gem",
  stone: "triangle",
  tree: "fir",
  rift: "crack",
  wisp: "spark",
} as const;
