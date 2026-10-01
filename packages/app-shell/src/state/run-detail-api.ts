import { DIFFICULTY_IDS } from "@bh/shared-types";
import { z } from "zod/mini";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";

/**
 * Лист забега в профиле (docs/35-stage4-plan.md, WP4): `GET /api/v1/runs/:runId`.
 * Отдельно от клиента забегов: тот едет в первой загрузке, а лист нужен
 * только профилю.
 *
 * Числа, которых сборка игрока не прислала, приходят `null`: лист показывает
 * то, что знает. Строковые виды — строкой, а не перечислением: вид новее
 * клиента рисуется общим текстом, а не роняет лист.
 */
const detailSchema = z.object({
  runId: z.string(),
  difficultyId: z.enum(DIFFICULTY_IDS),
  startingWeaponId: z.string(),
  at: z.number(),
  outcome: z.string(),
  survivalSec: z.number(),
  level: z.number(),
  enemiesKilled: z.number(),
  deathCause: z.nullable(z.string()),
  weapons: z.array(z.object({ id: z.string(), level: z.number(), damage: z.nullable(z.number()) })),
  passives: z.array(z.object({ id: z.string(), level: z.number() })),
  damageTaken: z.nullable(z.number()),
  xpCollected: z.nullable(z.number()),
  waveReached: z.nullable(z.number()),
  topKills: z.array(z.object({ enemy: z.string(), count: z.number() })),
  continues: z.number(),
  rating: z.string(),
  boosts: z.array(z.string()),
  reward: z.nullable(
    z.object({
      status: z.string(),
      reason: z.nullable(z.string()),
      coins: z.number(),
      xp: z.number(),
      levelBefore: z.number(),
      levelAfter: z.number(),
    }),
  ),
  loot: z.array(z.object({ slot: z.string(), rarity: z.string(), level: z.number() })),
});

export type RunDetail = z.infer<typeof detailSchema>;

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function loadRunDetail(runId: string, request: ApiRequest = apiRequest): Promise<ApiResult<RunDetail>> {
  return request(`/api/v1/runs/${encodeURIComponent(runId)}`, detailSchema, { method: "GET" });
}

/** Доля урона оружия в забеге — от суммы известных; урона не прислали — `null`. */
export function damageShares(weapons: RunDetail["weapons"]): (number | null)[] {
  const total = weapons.reduce((sum, weapon) => sum + (weapon.damage ?? 0), 0);
  return weapons.map((weapon) => (weapon.damage === null || total <= 0 ? null : weapon.damage / total));
}
