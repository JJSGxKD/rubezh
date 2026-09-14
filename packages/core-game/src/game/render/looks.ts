import type { EnemyPattern } from "@bh/shared-types";

/**
 * Как выглядит мир забега: формы и цвета врагов, кристаллов, подборов и
 * эффектов. Плейсхолдеры до прихода ассетов (docs/26-stage2-plan.md, WP1).
 *
 * Отдельно от рендера и без Phaser: те же данные рисует гайдбук оболочки,
 * и картинка в гайдбуке обязана совпадать с тем, что игрок видит в забеге.
 * Цвета здесь — палитра канвы, а не токены интерфейса: Phaser не читает CSS.
 */
export type ShapeKind =
  | "circle"
  | "square"
  | "triangle"
  | "diamond"
  | "ring"
  | "wave"
  | "hexagon"
  | "double"
  | "medkit"
  | "magnet"
  | "dynamite";

export interface ShapeLook {
  shape: ShapeKind;
  color: number;
}

/**
 * У каждого поведения своя форма и цвет, чтобы типы различались на глаз без
 * подписи.
 */
export const ENEMY_LOOKS: Record<EnemyPattern, ShapeLook> = {
  swarm: { shape: "circle", color: 0xff8f6b },
  chase: { shape: "square", color: 0xc06bff },
  kite_and_shoot: { shape: "triangle", color: 0x6bd5ff },
  dash: { shape: "diamond", color: 0xffd36b },
  orbit: { shape: "ring", color: 0x8cf0ff },
  exploder: { shape: "hexagon", color: 0xff5a5a },
  splitter: { shape: "double", color: 0x9be36b },
};

/**
 * Цвет врага на канве. Элита — половина пути к белому: считается по каналам,
 * а не подбирается вручную для каждого паттерна, — иначе новый паттерн однажды
 * останется без своего элитного цвета.
 */
export function enemyColor(pattern: EnemyPattern, elite: boolean): number {
  const color = ENEMY_LOOKS[pattern].color;
  if (!elite) return color;
  const mix = (channel: number): number => Math.round(channel + (255 - channel) * 0.45);
  const r = mix((color >> 16) & 0xff);
  const g = mix((color >> 8) & 0xff);
  const b = mix(color & 0xff);
  return (r << 16) | (g << 8) | b;
}

/**
 * Ступени ценности кристалла: цвет, размер и форма. Порог — минимальная
 * ценность ступени. Самая ценная ступень отличается ещё и формой, а не только
 * цветом (docs/27-design-system-and-app-shell.md §4.4).
 */
export const GEM_TIERS: readonly (ShapeLook & { minValue: number; radiusUnits: number })[] = [
  { minValue: 1, radiusUnits: 5, color: 0x5ccfff, shape: "diamond" },
  { minValue: 3, radiusUnits: 6.5, color: 0x5fe3a1, shape: "diamond" },
  { minValue: 8, radiusUnits: 8, color: 0xc47dff, shape: "diamond" },
  { minValue: 20, radiusUnits: 10, color: 0xffd36b, shape: "hexagon" },
];

/**
 * Подборы — по индексу вида в симуляции: аптечка, магнит, динамит. Виды
 * различаются силуэтом: крест, подкова, шашка с фитилём (§4.4).
 */
export const PICKUP_LOOKS: readonly (ShapeLook & { id: "medkit" | "magnet" | "dynamite"; key: string; size: number })[] = [
  { id: "medkit", key: "bh-medkit", shape: "medkit", color: 0xff5d5d, size: 1 },
  { id: "magnet", key: "bh-magnet-pickup", shape: "magnet", color: 0x5ccfff, size: 1.2 },
  { id: "dynamite", key: "bh-dynamite-pickup", shape: "dynamite", color: 0xff5d5d, size: 1.35 },
];

/** Остальная палитра мира: персонаж, снаряды, взрывы и земля. */
export const WORLD_COLORS = {
  player: 0x6ee7a8,
  projectile: 0xffe066,
  enemyProjectile: 0xff6b6b,
  orbiter: 0xffe0a3,
  blast: 0xffa24d,
  strike: 0x9bd0ff,
  heal: 0x5fe3a1,
  magnetWave: 0x5ccfff,
  dynamiteWave: 0xffb22e,
  /** вспышка персонажа при попадании */
  hurt: 0xff6b6b,
  ground: 0x0d0f14,
  groundLine: 0x171b24,
  /** светлые детали подборов: плашка аптечки, полюса магнита, фитиль */
  pickupLight: 0xf3f6fc,
  dynamiteBand: 0x3a1414,
  dynamiteSpark: 0xffe066,
} as const;
