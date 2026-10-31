import { z } from "zod";

/**
 * Запись забега для проверки (`run-proof-v1`, docs/35-stage4-plan.md WP5,
 * tasks/T-0316/T-0317): подмножество полной записи диагностики — всё, что
 * задаёт исход забега, и ничего лишнего. Клиент шлёт её сжатой и в base64;
 * это граница системы, поэтому каждый массив ограничен.
 *
 * Схема живёт в бэкенде, а не в `core-game`: собранный бэкенд не импортирует
 * исходники пакетов монорепо; форму сверяет тест вместе с клиентом (T-0316).
 */

const count = z.number().int().nonnegative();
const amount = z.number().nonnegative();
const id = z.string().max(64);

export const RUN_PROOF_SCHEMA = "run-proof-v1";

/** Параметры набора на забег — копия `LOADOUT_STATS` из shared-types; сверяет тест записи диагностики. */
const LOADOUT_STATS = [
  "damage",
  "cooldown",
  "area",
  "projectileSpeed",
  "duration",
  "moveSpeed",
  "pickupRadius",
  "maxHp",
  "regenPerSec",
  "armor",
  "resistFire",
  "resistCold",
  "resistLightning",
  "resistPoison",
  "damageFire",
  "damageCold",
  "damageLightning",
  "damagePoison",
  "statusChance",
] as const;

/** Бустов на забег — `MAX_LOADOUT_BOOSTS` движка. */
const MAX_BOOSTS = 8;
/** Потолок продолжений за забег — `MAX_CONTINUES_PER_RUN` движка. */
const MAX_CONTINUES = 5;

const loadoutSchema = z.object({
  modifiers: z.partialRecord(z.enum(LOADOUT_STATS), z.number().finite().nonnegative().max(1000)),
  boosts: z.array(id).max(MAX_BOOSTS),
  // Уровень аккаунта решает, что было открыто: без него повтор открыл бы всё и разошёлся с забегом.
  accountLevel: z.number().int().min(1).max(1000).optional(),
});

export const runProofSchema = z.object({
  schema: z.literal(RUN_PROOF_SCHEMA),
  runId: z.string().min(1).max(64),
  seed: z.number().int(),
  mapId: id,
  difficultyId: id,
  mode: id,
  startingWeaponId: id,
  contentHash: id,
  /** физических пикселей на игровую единицу: мир считается в них */
  unitScale: z.number().positive().max(10),
  loadout: loadoutSchema,
  /** класс устройства — для разбора расхождений; на исход не влияет */
  deviceClass: z.string().max(16).optional(),
  input: z.object({
    encoding: z.literal("rle-v1"),
    ticks: count,
    // Лог ввода — серии base64 до потолка записи; не влез (`truncated`) — запись не шлют, повторить такой забег нельзя.
    data: z
      .string()
      .max(64_004)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
    truncated: z.boolean(),
  }),
  /** выборы улучшений, сундуков и инструментов карточек: тик и вариант */
  choices: z.array(z.tuple([count, id])).max(4000),
  /** тики вторых шансов */
  continues: z.array(count).max(MAX_CONTINUES),
  /** свёртка мира раз в минуту забега: где повтор разошёлся с оригиналом */
  checkpoints: z.array(z.tuple([count, z.number().int()])).max(720),
  result: z.object({
    ticks: count,
    survivalSec: amount,
    level: count,
    enemiesKilled: count,
    deathCause: id.nullable(),
    checksum: z.number().int(),
  }),
});

export type RunProof = z.infer<typeof runProofSchema>;

/** Тело `PUT /api/v1/runs/:runId/proof`: сжатая gzip-ом запись в base64. Размер проверяет сервис — у него русская причина. */
export const runProofBodySchema = z.strictObject({ proof: z.string().min(1).max(200_000) });
