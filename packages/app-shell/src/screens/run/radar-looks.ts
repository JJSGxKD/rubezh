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
} as const;
