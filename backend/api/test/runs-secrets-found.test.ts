import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runFinishSchema } from "../src/modules/runs/dto/runs.dto.js";

/**
 * Найденные виды тайников в итоге забега (tasks/T-0261): сервер открывает по ним кодекс
 * тайников. Проверяется форма приёма: старый клиент без поля, пустой и битый список, потолок.
 */

function body(secretsFound?: unknown): Record<string, unknown> {
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
      ...(secretsFound === undefined ? {} : { secretsFound }),
    },
  };
}

describe("итог забега: secretsFound", () => {
  it("итог с полем разбирается, список остаётся как пришёл", () => {
    expect(runFinishSchema.parse(body(["shrine", "hoard"])).stats?.secretsFound).toEqual(["shrine", "hoard"]);
  });

  it("итог без поля (старый клиент) разбирается, как раньше", () => {
    const parsed = runFinishSchema.parse(body());
    expect(parsed.stats).toBeDefined();
    expect(parsed.stats?.secretsFound).toBeUndefined();
  });

  it("пустой список — годный итог: тайников не нашли", () => {
    expect(runFinishSchema.safeParse(body([])).success).toBe(true);
  });

  it("двенадцать записей проходят, тринадцать — отказ", () => {
    const kinds = (count: number): string[] => Array.from({ length: count }, () => "shrine");
    expect(runFinishSchema.safeParse(body(kinds(12))).success).toBe(true);
    expect(runFinishSchema.safeParse(body(kinds(13))).success).toBe(false);
  });

  it("пустая и слишком длинная строка и не массив строк — битые данные", () => {
    expect(runFinishSchema.safeParse(body([""])).success).toBe(false);
    expect(runFinishSchema.safeParse(body(["x".repeat(17)])).success).toBe(false);
    expect(runFinishSchema.safeParse(body("shrine")).success).toBe(false);
    expect(runFinishSchema.safeParse(body([1])).success).toBe(false);
  });
});
