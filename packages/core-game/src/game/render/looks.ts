import type { EnemyPattern } from "@bh/shared-types";

/**
 * Как выглядит мир забега: формы и цвета врагов, кристаллов, подборов и
 * эффектов. Облик — «Сумеречный рубеж», вид боя «цвет по угрозе»
 * (`design/README.md`): враги красные и различаются формой, опасное — каймой,
 * кристаллы яркие, обереги бирюзовые, земля — средний сумеречный тон.
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
  /** персонаж: светлое тело в тёмном канте */
  | "player"
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
 * Все враги — красная гамма, поэтому главное различие типа — форма, а оттенок
 * лишь подсказывает: круг, квадрат, клин читаются на глаз без подписи.
 */
export const ENEMY_LOOKS: Record<EnemyPattern, ShapeLook> = {
  swarm: { shape: "circle", color: 0xff4d5a },
  chase: { shape: "square", color: 0xe0245e },
  kite_and_shoot: { shape: "triangle", color: 0xff6a6a },
  // Ромб отдан кристаллам опыта: рывковый враг — остриё, и цвет у него
  // тревожный, а не «подбери меня».
  dash: { shape: "chevron", color: 0xff5a2e },
  orbit: { shape: "ring", color: 0xff7a90 },
  exploder: { shape: "hexagon", color: 0xff3b30 },
  splitter: { shape: "double", color: 0xd93a6a },
  // Рой проносится мимо: мелкая быстрая мошкара, не похожая на тех, кто идёт
  // на игрока, — форма угловатая, цвет светлее прочих.
  rush: { shape: "mote", color: 0xff9a8a },
  // Кастер стоит в стороне и светится перед ударом: тяжёлая фигура-глаз и самый
  // тёмный оттенок.
  caster: { shape: "eye", color: 0xc2185b },
};

/** Ранг врага на канве: обычный не задан. */
export type EnemyRankLook = "elite" | "boss" | undefined;

/**
 * Цвет и доля смешения тела с цветом ранга: элита — жар очага, босс —
 * ярко-малиновый. Не #e0245e: это цвет рядового `chase`, и его босс не
 * отличался бы от рядового.
 */
const RANK_TINT = {
  elite: { color: 0xff8f3f, mix: 0.35 },
  boss: { color: 0xff4f8f, mix: 0.4 },
} as const;

/**
 * Цвет врага на канве. Ранг смешивает тело с цветом ранга по каналам, а не
 * подбирается вручную для каждого паттерна, — иначе новый паттерн однажды
 * останется без своего цвета элиты.
 */
export function enemyColor(pattern: EnemyPattern, rank: EnemyRankLook): number {
  const color = ENEMY_LOOKS[pattern].color;
  if (rank === undefined) return color;
  return mixChannels(color, RANK_TINT[rank].color, RANK_TINT[rank].mix);
}

/** Кайма опасного: золотая, толще у босса. Обводка у рядовых «странновато выглядит» — её нет. */
export interface EnemyRim {
  color: number;
  /** толщина в игровых единицах */
  width: number;
}

export function enemyRim(rank: EnemyRankLook): EnemyRim | null {
  if (rank === "elite") return { color: 0xffd15c, width: 2 };
  if (rank === "boss") return { color: 0xffd15c, width: 3 };
  return null;
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
  // Тонировка красного в оранжевый и красный осталась бы незаметной: вторая
  // ступень светлеет к золоту, третья темнеет к тёмно-вишнёвому.
  { mixColor: 0xffd15c, mix: 0.25, core: 0xfff1d6 },
  { mixColor: 0x3b0a1f, mix: 0.35, core: 0xffd9e0 },
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
  { minValue: 1, radiusUnits: 5, color: 0xb6ff4a, shape: "gem" },
  { minValue: 3, radiusUnits: 6.5, color: 0xa8f4ff, shape: "gem" },
  { minValue: 8, radiusUnits: 8, color: 0xd68cff, shape: "gem" },
  // Самый ценный — тоже кристалл, а не другая фигура: ступень читается
  // размером, цветом и искрой внутри, но остаётся кристаллом.
  { minValue: 20, radiusUnits: 10.5, color: 0xffd15c, shape: "gem_rich" },
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

/**
 * Остальная палитра мира: персонаж, снаряды, взрывы и земля.
 *
 * Персонаж — единственное, на что игрок смотрит постоянно, и он не делит цвет
 * ни с кольцами вокруг себя, ни с врагами: иначе тело и кольцо здоровья
 * слились бы в одно пятно. Тело светлое и нейтральное, цвет несут кольца.
 */
export const WORLD_COLORS = {
  player: 0xf4f7ff,
  /** тёмный кант персонажа: светлое тело на светлом фоне иначе теряется */
  playerEdge: 0x1d1c31,
  projectile: 0xffe066,
  enemyProjectile: 0xff6b6b,
  orbiter: 0x46d9c6,
  blast: 0xffa24d,
  strike: 0x9bd0ff,
  heal: 0x8ee86b,
  magnetWave: 0x5ccfff,
  dynamiteWave: 0xffb22e,
  /** вспышка персонажа при попадании */
  hurt: 0xff6b6b,
  /**
   * Телеграфы атак врагов — кольцо взрыва, полоса рывка, прицел: всё, что
   * грозит игроку, — красным (`35-stage4-plan.md`, Р57). Жёлтый и тёплые
   * тона — за игроком: его снаряды и опыт, и угроза не должна с ними путаться.
   */
  threat: 0xff5a5a,
  /** граница зоны «Очага» */
  aura: 0xff9a3c,
  /** молния «Грозы»: ореол и светлый стержень */
  lightning: 0x9bd0ff,
  /** раскалённое ядро вражеского снаряда */
  enemyProjectileCore: 0xfff1e6,
  /** кольцо здоровья: полное, на исходе и почти пустое */
  hpFull: 0xff6f90,
  hpMid: 0xffc14d,
  hpLow: 0xff3b5c,
  /** кольцо опыта вокруг персонажа */
  xpRing: 0xb6ff4a,
  /** блик на грани кристалла */
  gemLight: 0xffffff,
  lightningCore: 0xf3f6fc,
  ground: 0x2b4152,
  groundLine: 0x33495b,
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
