import { describe, expect, it } from "vitest";
import { circling } from "../../packages/core-game/test/helpers/recorded-run";
import { runWithProof } from "../../packages/core-game/test/helpers/proof-run";
import { RUN_PROOF_SCHEMA } from "../../packages/core-game/src/run-api";
import { RUN_PROOF_SCHEMA as SERVER_SCHEMA, runProofSchema } from "../../backend/api/src/modules/runs/dto/run-proof.dto.js";

// Запись для проверки на двух сторонах: движок пишет, приёмник разбирает своей
// схемой (docs/28-diagnostics.md §3.4, tasks/T-0316, T-0317). Схема приёмника
// живёт в бэкенде отдельно от типов движка — разойдутся, и записи игроков
// молча получат 422 и не будут проверены.

describe("схема записи для проверки", () => {
  it("название формата одно на обе стороны", () => {
    expect(RUN_PROOF_SCHEMA).toBe(SERVER_SCHEMA);
  });

  it("приёмник принимает настоящую запись движка без потерь полей", () => {
    const run = runWithProof({ seed: 42, maxTicks: 5_000, steer: circling(200) });
    const parsed = runProofSchema.safeParse(run.proof);

    expect(parsed.error?.issues ?? []).toEqual([]);
    // Схема не выбрасывает полей движка: повтору нужно всё.
    expect(parsed.data).toEqual(run.proof);
  });

  it("и запись со снаряжением, слабым устройством и вторым шансом", () => {
    const loadout = { modifiers: { damage: 0.25, maxHp: 30, resistCold: 0.1 }, boosts: ["magnet_start"], accountLevel: 7, deviceClass: "light" as const };
    const withLoadout = runWithProof({ seed: 42, maxTicks: 3_000, steer: circling(200), loadout });
    const withContinues = runWithProof({ seed: 99, maxTicks: 40_000, difficultyId: "hard", steer: () => null, continues: true });

    for (const run of [withLoadout, withContinues]) {
      const parsed = runProofSchema.safeParse(run.proof);
      expect(parsed.error?.issues ?? []).toEqual([]);
      expect(parsed.data).toEqual(run.proof);
    }
    expect(withLoadout.proof?.deviceClass).toBe("light");
    expect(withContinues.proof?.continues.length).toBeGreaterThan(0);
  });

  it("и запись, продолженная из снимка", () => {
    const run = runWithProof({ seed: 42, maxTicks: 3_000, steer: circling(200), snapshotAtTick: 1_500 });
    const parsed = runProofSchema.safeParse(run.proof);

    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data).toEqual(run.proof);
  });
});
