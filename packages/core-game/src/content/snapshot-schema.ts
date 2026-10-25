import {
  DIFFICULTY_IDS,
  ELEMENTS,
  LOADOUT_STATS,
  PASSIVE_CATEGORIES,
  type EnemyDef,
  type EnemyPattern,
  type EnemyPatternParams,
} from "@bh/shared-types";
import { z } from "zod";
import type { ContentSnapshot } from "./snapshot";

/**
 * Схема снимка контента: форма, обязательные поля и числа без NaN и
 * бесконечности. Её читают три потребителя — разбор JSON-черновика в песочнице
 * редактора баланса, проверка правки на сервере (через `z.toJSONSchema`, не
 * импортируя пакеты игры) и тест, что снимок по умолчанию ей соответствует.
 *
 * Здесь только то, что видно по одному полю: знак, целое, список значений.
 * Правила, где поля зависят друг от друга или от игры — ссылки на врагов,
 * бюджет угрозы, коридоры, — это `findContentProblems`: дублировать их здесь
 * значило бы вести две проверки, которые рано или поздно разойдутся.
 *
 * Объекты строгие: опечатка в имени поля в JSON-черновике должна быть
 * ошибкой, а не молча проигнорированным значением.
 */

const num = z.number();
const positive = z.number().positive();
const nonNegative = z.number().nonnegative();
const count = z.int().nonnegative();
const text = z.string().min(1);
const range = z.strictObject({ min: num, max: num });

const patternParams = {
  swarm: z.strictObject({}),
  chase: z.strictObject({ steeringPerSec: num.optional() }),
  kite_and_shoot: z.strictObject({
    preferredDistance: num.optional(),
    shotIntervalSec: num.optional(),
    projectileSpeed: num.optional(),
  }),
  dash: z.strictObject({
    triggerDistance: num.optional(),
    telegraphSec: num.optional(),
    dashSpeed: num.optional(),
    dashDurationSec: num.optional(),
    recoverSec: num.optional(),
  }),
  orbit: z.strictObject({ orbitRadius: num.optional(), shrinkPerSec: num.optional(), minRadius: num.optional() }),
  exploder: z.strictObject({ triggerDistance: num.optional(), fuseSec: num.optional(), blastRadius: num.optional() }),
  splitter: z.strictObject({ children: z.array(z.strictObject({ enemy: text, count: num.optional() })) }),
  caster: z.strictObject({
    preferredDistance: num.optional(),
    castIntervalSec: num.optional(),
    telegraphSec: num.optional(),
    burstCount: num.optional(),
    projectileSpeed: num.optional(),
  }),
  rush: z.strictObject({ leadSec: num.optional(), runSec: num.optional() }),
  cordon: z.strictObject({}),
} satisfies Record<EnemyPattern, z.ZodType>;

const statusElements = ELEMENTS.filter((element) => element !== "physical") as [
  Exclude<(typeof ELEMENTS)[number], "physical">,
  ...Exclude<(typeof ELEMENTS)[number], "physical">[],
];

const enemyBase = {
  id: text,
  hp: positive,
  speed: positive,
  damage: nonNegative,
  xp: nonNegative,
  threat: positive.optional(),
  rank: z.enum(["elite", "boss"]).optional(),
  size: positive.optional(),
  resist: z.partialRecord(z.enum(statusElements), num).optional(),
  element: z.enum(statusElements).optional(),
  statusChance: num.optional(),
};

/** Враг одного паттерна: параметры обязательны только там, где умолчания нет. */
function enemyOf<P extends EnemyPattern>(pattern: P, params: z.ZodType<EnemyPatternParams[P]>, paramsRequired: boolean) {
  return z.strictObject({
    ...enemyBase,
    pattern: z.literal(pattern),
    params: paramsRequired ? params : params.optional(),
  });
}

const enemySchema = z.discriminatedUnion("pattern", [
  enemyOf("swarm", patternParams.swarm, false),
  enemyOf("chase", patternParams.chase, false),
  enemyOf("kite_and_shoot", patternParams.kite_and_shoot, false),
  enemyOf("dash", patternParams.dash, false),
  enemyOf("orbit", patternParams.orbit, false),
  enemyOf("exploder", patternParams.exploder, false),
  enemyOf("splitter", patternParams.splitter, true),
  enemyOf("caster", patternParams.caster, false),
  enemyOf("rush", patternParams.rush, false),
  enemyOf("cordon", patternParams.cordon, false),
]);

const stageSchema = z.strictObject({
  fromSec: nonNegative,
  weight: positive,
  hpMul: positive,
  damageMul: positive,
  speedMul: positive,
  xpMul: positive,
  nameKey: text.optional(),
});

const element = z.enum(ELEMENTS);

const weaponLevelSchema = z.strictObject({
  damage: positive,
  cooldownSec: positive,
  projectiles: num.optional(),
  pierce: num.optional(),
  areaRadius: num.optional(),
  projectileSpeed: num.optional(),
  ttlSec: num.optional(),
  statusChance: num.optional(),
});

const weaponSchema = z.strictObject({
  id: text,
  behavior: z.enum(["projectile_nearest", "projectile_facing", "orbit", "aura", "area_strike"]),
  nameKey: text,
  descriptionKey: text,
  weight: positive.optional(),
  element: element.optional(),
  evolvedFrom: text.optional(),
  recipe: z.strictObject({ passive: text }).optional(),
  levels: z.array(weaponLevelSchema),
});

const playerStats = [
  "damage",
  "cooldown",
  "area",
  "projectileSpeed",
  "duration",
  "projectiles",
  "moveSpeed",
  "maxHp",
  "regenPerSec",
  "pickupRadius",
  "armor",
  "resist",
  "resistFire",
  "resistCold",
  "resistLightning",
  "resistPoison",
] as const;

const category = z.enum(PASSIVE_CATEGORIES as [string, ...string[]]) as z.ZodType<(typeof PASSIVE_CATEGORIES)[number]>;

const passiveSchema = z.strictObject({
  id: text,
  nameKey: text,
  descriptionKey: text,
  category,
  stat: z.enum(playerStats),
  op: z.enum(["add", "mul"]),
  weight: positive.optional(),
  levels: z.array(num),
});

const loadoutModifiers = z.partialRecord(z.enum(LOADOUT_STATS), num);

const categoryCounts = z.strictObject({ attack: count, defense: count, mobility: count });

const unlockSchema = z.strictObject({
  level: z.int().positive(),
  weapons: z.array(text).optional(),
  passives: z.array(text).optional(),
  slots: z
    .strictObject({
      weapons: count.optional(),
      passives: categoryCounts.partial().optional(),
    })
    .optional(),
});

const ringSchema = z.strictObject({ radius: num, minRadius: num, shrinkPerSec: num, lifeSec: num });
const eventKind = z.enum(["ring", "flank", "cordon"]);

const segmentSchema = z.strictObject({
  fromSec: nonNegative,
  maxAlive: num.optional(),
  spawns: z.array(z.strictObject({ enemy: text, perSec: num.optional(), burst: num.optional() })),
  events: z.array(z.strictObject({ kind: eventKind, enemy: text, count: num, ring: ringSchema.optional() })).optional(),
});

const curveSchema = z.strictObject({
  fromSec: nonNegative,
  segmentSec: positive,
  threatPerSec: positive,
  threatGrowth: num,
  maxAlive: num,
  hpGrowth: num,
  damageGrowth: num,
  pool: z.array(text),
  startTypes: num,
  typesPerSegment: num,
  mixSize: num,
  events: z.array(z.strictObject({ everySegments: num, kind: eventKind, enemy: text, count: num, ring: ringSchema.optional() })),
});

const mapSchema = z.strictObject({
  id: text,
  nameKey: text,
  bounds: z.strictObject({ halfWidth: positive.optional(), halfHeight: positive.optional() }).optional(),
  camera: z.strictObject({
    viewAreaMoving: positive,
    viewAreaIdle: positive,
    maxAspect: positive,
    followSmoothingSec: nonNegative,
    zoomSmoothingSec: nonNegative,
    zoomInDelaySec: nonNegative,
  }),
});

const pickupChances = { chance: num, eliteChance: num, maxOnField: count };

const dropsSchema = z.strictObject({
  gems: z.strictObject({ maxPerKill: num }),
  medkits: z.strictObject({ ...pickupChances, healRatio: num }),
  magnets: z.strictObject({ ...pickupChances }),
  dynamite: z.strictObject({ ...pickupChances, radiusUnits: num, eliteHpRatio: num }),
  freeze: z.strictObject({ ...pickupChances, durationSec: num, bossDurationRatio: num }),
});

const chestSize = z.union([z.literal(1), z.literal(3), z.literal(5)]);

const chestsSchema = z.strictObject({
  opening: z.array(chestSize),
  sizes: z.array(z.strictObject({ size: chestSize, weight: num })),
  bossMinSize: chestSize,
  ownedWeightMul: num,
  lowHpRatio: num,
  xpRatio: num,
  maxOnField: count,
});

const difficultySchema = z.strictObject({
  id: z.enum(DIFFICULTY_IDS as [string, ...string[]]) as z.ZodType<(typeof DIFFICULTY_IDS)[number]>,
  nameKey: text,
  descriptionKey: text,
  enemyHpMul: positive,
  enemyDamageMul: positive,
  spawnRateMul: positive,
  maxAliveMul: positive,
});

const continueSchema = z.strictObject({ perRun: count, restoreHpRatio: num, invulnerableSec: nonNegative });

const cardTools = { reroll: count.optional(), skip: count.optional(), banish: count.optional() };

const boostSchema = z.strictObject({
  id: text,
  nameKey: text,
  descriptionKey: text,
  modifiers: loadoutModifiers.optional(),
  shieldHits: num.optional(),
  startLevels: num.optional(),
  extraOffers: num.optional(),
  cardTools: z.strictObject(cardTools).optional(),
});

const balanceTargetsSchema = z.strictObject({
  passiveDeathBeforeSec: positive,
  dodgingMedianSec: range,
  dodgingDeathsBeforeMinuteRatioMax: num,
  firstLevelUpSec: range,
  firstChestEventSec: range,
  evolutionPowerRatio: range,
});

export const contentSnapshotSchema: z.ZodType<ContentSnapshot> = z.strictObject({
  schemaVersion: z.literal(1),
  enemies: z.array(enemySchema) as z.ZodType<readonly EnemyDef[]>,
  stages: z.array(stageSchema),
  weapons: z.array(weaponSchema),
  passives: z.array(passiveSchema),
  levelCurve: z.strictObject({ baseXp: positive, growth: positive }),
  loadoutLimits: z.strictObject({ weapons: count, passives: categoryCounts }),
  accountUnlocks: z.array(unlockSchema),
  timeline: z.array(segmentSchema),
  endlessCurve: curveSchema,
  maps: z.array(mapSchema),
  drops: dropsSchema,
  chests: chestsSchema,
  difficulties: z.array(difficultySchema),
  continueRules: continueSchema,
  boosts: z.array(boostSchema),
  maxBoostsPerRun: count,
  cardToolUnlocks: z.array(z.strictObject({ level: z.int().positive(), ...cardTools })),
  cardToolRules: z.strictObject({ skipXpRatio: num }),
  balanceTargets: balanceTargetsSchema,
});

/**
 * JSON-схема снимка для сервера: он проверяет форму правки, не импортируя ни
 * Zod, ни пакеты игры. Строится из той же схемы, поэтому с ней не расходится.
 */
export function contentSnapshotJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(contentSnapshotSchema);
}
