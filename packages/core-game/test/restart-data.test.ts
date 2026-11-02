import type { RunLoadout } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { RunBus } from "../src/engine/run-bus";
import { restartSceneData } from "../src/game/run/restart-data";
import type { MainSceneData } from "../src/game/MainScene";
import type { RunSnapshot } from "../src/run-api";

// «Ещё раз» из экрана итогов (T-0190): данные новой сцены. После обучающего
// забега следующий идёт на единой сложности, поэтому сложность можно сменить.

function sceneData(patch: Partial<MainSceneData> = {}): MainSceneData {
  const loadout: RunLoadout = { modifiers: { damage: 0.1 }, boosts: ["fury", "aegis"], accountLevel: 5 };
  return {
    seed: 7,
    unitScale: 2,
    mapId: "frontier",
    difficultyId: "easy",
    startingWeaponId: "spark",
    bus: new RunBus(),
    runId: "run-old",
    resume: { runId: "run-old" } as unknown as RunSnapshot,
    loadout,
    ...patch,
  };
}

describe("restartSceneData", () => {
  it("заменяет сид и убирает продолжение и id забега", () => {
    const next = restartSceneData(sceneData(), 99);
    expect(next.seed).toBe(99);
    expect("resume" in next).toBe(false);
    expect("runId" in next).toBe(false);
  });

  it("обнуляет бусты снаряжения, остальное снаряжение оставляет", () => {
    const next = restartSceneData(sceneData(), 99);
    expect(next.loadout).toEqual({ modifiers: { damage: 0.1 }, boosts: [], accountLevel: 5 });
  });

  it("не трогает остальные поля", () => {
    const data = sceneData();
    const next = restartSceneData(data, 99);
    expect(next).toMatchObject({ unitScale: 2, mapId: "frontier", startingWeaponId: "spark" });
    expect(next.bus).toBe(data.bus);
  });

  it("без сложности оставляет прежнюю", () => {
    expect(restartSceneData(sceneData({ difficultyId: "normal" }), 99).difficultyId).toBe("normal");
  });

  it("с сложностью ставит новую", () => {
    expect(restartSceneData(sceneData({ difficultyId: "easy" }), 99, "hard").difficultyId).toBe("hard");
  });

  it("исходный объект не меняется", () => {
    const data = sceneData();
    restartSceneData(data, 99, "hard");
    expect(data.seed).toBe(7);
    expect(data.difficultyId).toBe("easy");
    expect(data.runId).toBe("run-old");
    expect(data.resume).toBeDefined();
    expect(data.loadout?.boosts).toEqual(["fury", "aegis"]);
  });

  it("забег без снаряжения остаётся без снаряжения", () => {
    const data = sceneData();
    delete data.loadout;
    expect("loadout" in restartSceneData(data, 99)).toBe(false);
  });
});
