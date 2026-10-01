import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { damageShares, loadRunDetail } from "../src/state/run-detail-api";

// Лист забега в профиле (docs/35-stage4-plan.md, WP4): ответ сервера — схемой,
// забег прошлой сборки без подробностей — не ошибка, а вид новее клиента не
// роняет лист.

function server(paths: string[], answer: unknown): ApiRequest {
  return async <T,>(path: string, schema: object): Promise<ApiResult<T>> => {
    paths.push(path);
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
    return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
  };
}

const DETAIL = {
  runId: "run/1",
  difficultyId: "hard",
  startingWeaponId: "spark",
  at: 1_790_000_000_000,
  outcome: "died",
  survivalSec: 420,
  level: 14,
  enemiesKilled: 900,
  deathCause: "swarm_rat",
  weapons: [
    { id: "spark", level: 6, damage: 7500 },
    { id: "knife", level: 3, damage: 2500 },
  ],
  passives: [{ id: "might", level: 2 }],
  damageTaken: 640,
  xpCollected: 1200,
  waveReached: 6,
  topKills: [{ enemy: "swarm_rat", count: 700 }],
  continues: 1,
  rating: "ranked",
  boosts: ["fury"],
  reward: { status: "granted", reason: null, coins: 140, xp: 210, levelBefore: 4, levelAfter: 5 },
  loot: [{ slot: "armor", rarity: "rare", level: 3 }],
};

describe("лист забега", () => {
  it("запрашивает свой забег по id, экранируя его в пути", async () => {
    const paths: string[] = [];
    const response = await loadRunDetail("run/1", server(paths, DETAIL));
    expect(paths).toEqual(["/api/v1/runs/run%2F1"]);
    expect(response.ok && response.data.loot).toEqual([{ slot: "armor", rarity: "rare", level: 3 }]);
  });

  it("забег прошлой сборки без подробностей и награды — не ошибка; вид новее клиента — тоже", async () => {
    const old = { ...DETAIL, weapons: [{ id: "spark", level: 6, damage: null }], passives: [], damageTaken: null, xpCollected: null, waveReached: null, topKills: [], reward: null, rating: "something_new" };
    expect((await loadRunDetail("r", server([], old))).ok).toBe(true);
  });

  it("ответ без обязательного поля — отказ, а не лист с дырами", async () => {
    const broken: Record<string, unknown> = { ...DETAIL };
    delete broken.enemiesKilled;
    expect((await loadRunDetail("r", server([], broken))).ok).toBe(false);
  });

  it("доля урона — от известного; без урона доли нет", () => {
    expect(damageShares(DETAIL.weapons)).toEqual([0.75, 0.25]);
    expect(damageShares([{ id: "spark", level: 1, damage: null }, { id: "knife", level: 1, damage: 100 }])).toEqual([null, 1]);
    expect(damageShares([{ id: "spark", level: 1, damage: 0 }])).toEqual([null]);
  });
});
