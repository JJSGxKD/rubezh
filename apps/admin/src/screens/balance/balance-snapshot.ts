import { z } from "zod";

/**
 * Форма снимка контента — только то, что читают таблицы баланса. Панель не
 * импортирует пакеты игры (`layer-boundaries.test.ts`), поэтому схема своя и
 * нестрогая: лишние поля снимка пропускаются, а значения правятся по пути на
 * сервере, где форму проверяет полная схема версии.
 *
 * Необязательные поля врага и уровней — именно необязательные: ячейка у
 * отсутствующего поля не правится (убрать поле правкой нельзя, а добавленное
 * не вернуть).
 */

const ELEMENTS = ["fire", "cold", "lightning", "poison"] as const;
export type ResistElement = (typeof ELEMENTS)[number];

const numberField = z.number();

const enemySchema = z.looseObject({
  id: z.string(),
  hp: numberField,
  speed: numberField,
  damage: numberField,
  xp: numberField,
  threat: numberField.optional(),
  rank: z.enum(["elite", "boss"]).optional(),
  pattern: z.string(),
  resist: z.partialRecord(z.enum(ELEMENTS), numberField).optional(),
});
export type EnemyRow = z.infer<typeof enemySchema>;

const stageSchema = z.looseObject({
  fromSec: numberField,
  weight: numberField,
  hpMul: numberField,
  damageMul: numberField,
  speedMul: numberField,
  xpMul: numberField,
  nameKey: z.string().optional(),
});
export type StageRow = z.infer<typeof stageSchema>;

const spawnSchema = z.looseObject({ enemy: z.string(), perSec: numberField.optional(), burst: numberField.optional() });
const eventSchema = z.looseObject({ kind: z.string(), enemy: z.string(), count: numberField });
const segmentSchema = z.looseObject({
  fromSec: numberField,
  maxAlive: numberField.optional(),
  spawns: z.array(spawnSchema),
  events: z.array(eventSchema).optional(),
});
export type SegmentRow = z.infer<typeof segmentSchema>;

const weaponLevelSchema = z.looseObject({
  damage: numberField,
  cooldownSec: numberField,
  projectiles: numberField.optional(),
  pierce: numberField.optional(),
  areaRadius: numberField.optional(),
  projectileSpeed: numberField.optional(),
  ttlSec: numberField.optional(),
  statusChance: numberField.optional(),
});
export type WeaponLevelRow = z.infer<typeof weaponLevelSchema>;

const weaponSchema = z.looseObject({
  id: z.string(),
  behavior: z.string(),
  nameKey: z.string(),
  element: z.string().optional(),
  evolvedFrom: z.string().optional(),
  recipe: z.looseObject({ passive: z.string() }).optional(),
  levels: z.array(weaponLevelSchema),
});
export type WeaponRow = z.infer<typeof weaponSchema>;

const passiveSchema = z.looseObject({
  id: z.string(),
  nameKey: z.string(),
  category: z.string(),
  stat: z.string(),
  op: z.string(),
  levels: z.array(numberField),
});
export type PassiveRow = z.infer<typeof passiveSchema>;

const unlockSchema = z.looseObject({
  level: numberField,
  weapons: z.array(z.string()).optional(),
  passives: z.array(z.string()).optional(),
  slots: z
    .looseObject({
      weapons: numberField.optional(),
      passives: z.looseObject({ attack: numberField.optional(), defense: numberField.optional(), mobility: numberField.optional() }).optional(),
    })
    .optional(),
});
export type UnlockRow = z.infer<typeof unlockSchema>;

const chestSize = z.union([z.literal(1), z.literal(3), z.literal(5)]);
const chestSizes = z.array(z.looseObject({ size: chestSize, weight: numberField }));

const difficultySchema = z.looseObject({
  id: z.string(),
  nameKey: z.string(),
  enemyHpMul: numberField,
  enemyDamageMul: numberField,
  spawnRateMul: numberField,
  maxAliveMul: numberField,
});
export type DifficultyRow = z.infer<typeof difficultySchema>;

/** Объект чисел одного раздела: параметры идут таблицей «название — значение». */
const params = z.looseObject({});

const snapshotSchema = z.looseObject({
  enemies: z.array(enemySchema),
  stages: z.array(stageSchema),
  weapons: z.array(weaponSchema),
  passives: z.array(passiveSchema),
  levelCurve: z.looseObject({ baseXp: numberField, growth: numberField, late: z.looseObject({ fromLevel: numberField, growth: numberField }).optional() }),
  accountUnlocks: z.array(unlockSchema),
  timeline: z.array(segmentSchema),
  endlessCurve: params,
  drops: params,
  chests: z.looseObject({ opening: z.array(chestSize), sizes: chestSizes, late: z.looseObject({ sizes: chestSizes }).optional() }),
  difficulties: z.array(difficultySchema),
});

export type BalanceSnapshot = z.infer<typeof snapshotSchema>;

export type ParsedSnapshot = { ok: true; snapshot: BalanceSnapshot } | { ok: false; message: string };

/** Снимок черновика или версии → то, что читают таблицы; не та форма — сообщение, а не исключение. */
export function parseSnapshot(raw: unknown): ParsedSnapshot {
  const parsed = snapshotSchema.safeParse(raw);
  if (parsed.success) return { ok: true, snapshot: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue === undefined ? "" : ` (${issue.path.map(String).join(".") || "корень"})`;
  return { ok: false, message: `Снимок контента не той формы${where} — панель и сервер разных версий?` };
}
