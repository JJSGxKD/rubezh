import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runFinishSchema } from "../src/modules/runs/dto/runs.dto.js";

/**
 * Типы врагов, вышедших в мир, в итоге забега (tasks/T-0479): сервер открывает по ним записи
 * кодекса. Проверяется форма приёма: потолок, старый клиент без поля, пустой и битый список.
 */

function body(enemiesSeen?: unknown): Record<string, unknown> {
  return {
    runId: randomUUID(),
    difficultyId: "hard",
    outcome: "died",
    survivalSec: 120,
    level: 6,
    enemiesKilled: 300,
    startingWeaponId: "knife",
    weapons: [{ id: "knife", level: 2 }],
    contentHash: "abc",
    deathCause: "swarm_rat",
    stats: {
      damageTaken: 10,
      xpCollected: 20,
      waveReached: 3,
      topKills: [{ enemy: "swarm_rat", count: 300 }],
      ...(enemiesSeen === undefined ? {} : { enemiesSeen }),
    },
  };
}

describe("итог забега: enemiesSeen", () => {
  it("итог с полем разбирается, список остаётся как пришёл", () => {
    const parsed = runFinishSchema.parse(body(["swarm_rat", "elite_ghoul", "boss_ram"]));

    expect(parsed.stats?.enemiesSeen).toEqual(["swarm_rat", "elite_ghoul", "boss_ram"]);
  });

  it("итог без поля (старый клиент) разбирается, как раньше", () => {
    const parsed = runFinishSchema.parse(body());

    expect(parsed.stats).toBeDefined();
    expect(parsed.stats?.enemiesSeen).toBeUndefined();
  });

  it("пустой список — годный итог: враги не вышли", () => {
    expect(runFinishSchema.safeParse(body([])).success).toBe(true);
  });

  it("64 записи проходят, 65 — 400", () => {
    const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => `enemy_${index}`);

    expect(runFinishSchema.safeParse(body(ids(64))).success).toBe(true);
    expect(runFinishSchema.safeParse(body(ids(65))).success).toBe(false);
  });

  it("пустой id и слишком длинный id — битые данные", () => {
    expect(runFinishSchema.safeParse(body([""])).success).toBe(false);
    expect(runFinishSchema.safeParse(body(["x".repeat(65)])).success).toBe(false);
  });

  it("не массив строк — битые данные", () => {
    expect(runFinishSchema.safeParse(body("swarm_rat")).success).toBe(false);
    expect(runFinishSchema.safeParse(body([1, 2])).success).toBe(false);
  });
});
