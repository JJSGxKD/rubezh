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
  /** остриё по направлению движения — рывковый враг */
  | "chevron"
  /** четыре тонких луча — пробегающий мимо рой */
  | "mote"
  /** кольцо со зрачком — кастующий босс */
  | "eye"
  /** гранёный кристалл опыта: свет сверху, тень снизу */
  | "gem"
  /** крупный кристалл: те же грани и искра в центре */
  | "gem_rich"
  /** снаряд врага: раскалённое ядро с ореолом */
  | "bolt"
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
  // Ромб отдан кристаллам опыта: рывковый враг — остриё, и цвет у него
  // тревожный, а не «подбери меня».
  dash: { shape: "chevron", color: 0xff7a1f },
  orbit: { shape: "ring", color: 0x8cf0ff },
  exploder: { shape: "hexagon", color: 0xff5a5a },
  splitter: { shape: "double", color: 0x9be36b },
  // Рой проносится мимо: мелкая быстрая мошкара, не похожая на тех, кто идёт
  // на игрока, — цвет холодный, форма угловатая.
  rush: { shape: "mote", color: 0xd8dce8 },
  // Кастер стоит в стороне и светится перед ударом: тяжёлая фигура и цвет,
  // которого больше ни у кого нет.
  caster: { shape: "eye", color: 0xb48cff },
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
 * Как читается ступень врага (content/stages.ts): тело уходит в цвет ступени,
 * а в середину садится светлое ядро.
 *
 * Не размером: размер уже занят рангом — элита крупнее обычного врага, и
 * второй смысл у того же признака читался бы как путаница. Не каймой: кайма
 * по кругу режет углы у квадрата и клина.
 */
export const STAGE_LOOKS: readonly { mixColor: number; mix: number; core: number | null }[] = [
  { mixColor: 0x000000, mix: 0, core: null },
  { mixColor: 0xffb038, mix: 0.3, core: 0xffe9b0 },
  { mixColor: 0xff3b2f, mix: 0.45, core: 0xffd9c0 },
];

/** Цвет тела врага на ступени: та же тварь, но матёрее. */
export function stageColor(color: number, stage: number): number {
  const look = STAGE_LOOKS[Math.min(stage, STAGE_LOOKS.length - 1)];
  if (look === undefined || look.mix <= 0) return color;
  return mixChannels(color, look.mixColor, look.mix);
}

/** Светлое ядро ступени; `null` — у обычного врага ядра нет. */
export function stageCore(stage: number): number | null {
  return STAGE_LOOKS[Math.min(stage, STAGE_LOOKS.length - 1)]?.core ?? null;
}

function mixChannels(from: number, to: number, ratio: number): number {
  const channel = (shift: number): number => {
    const a = (from >> shift) & 0xff;
    const b = (to >> shift) & 0xff;
    return Math.round(a + (b - a) * ratio);
  };
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

/**
 * Ступени ценности кристалла: цвет, размер и форма. Порог — минимальная
 * ценность ступени. Самая ценная ступень отличается ещё и формой, а не только
 * цветом (docs/27-design-system-and-app-shell.md §4.4).
 */
export const GEM_TIERS: readonly (ShapeLook & { minValue: number; radiusUnits: number })[] = [
  { minValue: 1, radiusUnits: 5, color: 0x5ccfff, shape: "gem" },
  { minValue: 3, radiusUnits: 6.5, color: 0x5fe3a1, shape: "gem" },
  { minValue: 8, radiusUnits: 8, color: 0xc47dff, shape: "gem" },
  // Самый ценный — тоже кристалл, а не другая фигура: ступень читается
  // размером, цветом и искрой внутри, но остаётся кристаллом.
  { minValue: 20, radiusUnits: 10.5, color: 0xffd36b, shape: "gem_rich" },
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
  /** телеграф взрыва: кольцо радиуса и растущий отсчёт */
  threat: 0xff5a5a,
  /** полоса рывка */
  dashLane: 0xffd36b,
  /** граница зоны «Очага» */
  aura: 0xff9a3c,
  /** молния «Грозы»: ореол и светлый стержень */
  lightning: 0x9bd0ff,
  /** раскалённое ядро вражеского снаряда */
  enemyProjectileCore: 0xfff1e6,
  /** блик на грани кристалла */
  gemLight: 0xffffff,
  lightningCore: 0xf3f6fc,
  ground: 0x0d0f14,
  groundLine: 0x171b24,
  /** светлые детали подборов: плашка аптечки, полюса магнита, фитиль */
  pickupLight: 0xf3f6fc,
  dynamiteBand: 0x3a1414,
  dynamiteSpark: 0xffe066,
} as const;

/**
 * Отладочная отрисовка режима разработчика. Цвета нарочно «инженерные» —
 * бирюза, фуксия, лайм: их нельзя спутать ни с врагом, ни с эффектом игры.
 */
export const DEBUG_COLORS = {
  hitboxEnemy: 0x39ff88,
  hitboxElite: 0xffe14d,
  hitboxProjectile: 0xff4dd2,
  hitboxPlayer: 0xffffff,
  pickupRadius: 0x4de1ff,
  weaponRadius: 0xff9a3c,
  weaponRange: 0xffe066,
  spawnRing: 0xff4d4d,
  retentionRing: 0x9b6bff,
  bounds: 0xff4dd2,
  grid: 0x4de1ff,
} as const;
