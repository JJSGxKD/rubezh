import { beforeEach, describe, expect, it } from "vitest";
import { createNoopPlatformUi, type KeyValueStorage, type PlatformAdapter } from "@bh/shared-types";
import type { RunCues } from "@bh/core-game";
import { volumeCurve } from "../src/audio/audio-engine";
import { DEFAULT_VOLUMES } from "../src/audio";
import { LAB_OVERRIDES_KEY, readLabOverrides, recipeSchema } from "../src/audio/lab-overrides";
import { BUSES, SOUND_RECIPES, UI_SOUNDS } from "../src/audio/recipes";
import { planCueSounds } from "../src/audio/sound-director";
import { sceneFor } from "../src/state/audio-sync";
import { useSettings } from "../src/state/settings";
import { initShell } from "../src/state/shell";

// Звук: рецепты, грань в плане звуков, сцены и громкость (docs/31-audio-and-haptics.md).

function cues(patch: Partial<RunCues> = {}): RunCues {
  return {
    playerHit: 0,
    heal: 0,
    magnet: 0,
    dynamite: 0,
    explosions: 0,
    explosionsNear: 0,
    strikes: 0,
    kills: 0,
    eliteKills: 0,
    eliteSpawns: 0,
    xp: 0,
    fuses: 0,
    dashWarns: 0,
    dashes: 0,
    enemyShots: 0,
    weapons: {},
    ...patch,
  };
}

function memoryStorage(values: Record<string, string> = {}): KeyValueStorage {
  return {
    get: (key) => values[key] ?? null,
    set: (key, value) => {
      values[key] = value;
    },
    remove: (key) => {
      delete values[key];
    },
  };
}

describe("рецепты звуков", () => {
  it("проходят схему лаборатории: правка из хранилища и код говорят на одном языке", () => {
    for (const [id, recipe] of Object.entries(SOUND_RECIPES)) {
      const parsed = recipeSchema.safeParse(recipe);
      expect(parsed.success, `${id}: ${parsed.success ? "" : parsed.error.issues[0]?.message}`).toBe(true);
      expect(BUSES[recipe.bus], id).toBeDefined();
      if ("pitch" in recipe && recipe.pitch !== undefined) expect(recipe.pitch.length, id).toBeGreaterThanOrEqual(recipe.variants);
    }
    for (const id of UI_SOUNDS) expect(SOUND_RECIPES[id].bus).toBe("ui");
  });

  it("правка с ошибкой пропускается, остальные применяются", () => {
    const storage = memoryStorage({
      [LAB_OVERRIDES_KEY]: JSON.stringify({
        uiTap: { ...SOUND_RECIPES.uiTap, level: 0.2 },
        spark: { ...SOUND_RECIPES.spark, voices: 99 },
        notASound: SOUND_RECIPES.uiTap,
      }),
    });
    const overrides = readLabOverrides(storage);
    expect(Object.keys(overrides)).toEqual(["uiTap"]);
    expect(overrides.uiTap?.level).toBe(0.2);
    expect(readLabOverrides(memoryStorage({ [LAB_OVERRIDES_KEY]: "{битый json" }))).toEqual({});
  });
});

describe("план звуков забега", () => {
  it("на пачку убийств — не больше трёх хлопков вразбивку", () => {
    const pops = planCueSounds(cues({ kills: 40 }), 0).filter((request) => request.id === "popSmall");
    expect(pops).toHaveLength(3);
    expect(pops.map((request) => request.options.delay)).toEqual([0, 0.035, 0.07]);
  });

  it("взрыв вдали тише взрыва рядом, «Гроза» звучит ударом, а не срабатыванием", () => {
    expect(planCueSounds(cues({ explosions: 2, explosionsNear: 1 }), 0)).toContainEqual({ id: "blast", options: {} });
    expect(planCueSounds(cues({ explosions: 2 }), 0)).toContainEqual({ id: "blast", options: { gain: 0.35 } });
    const storm = planCueSounds(cues({ weapons: { storm: 1, spark: 1 } }), 0).map((request) => request.id);
    expect(storm).toEqual(["spark"]);
    expect(planCueSounds(cues({ strikes: 1 }), 0).map((request) => request.id)).toEqual(["storm"]);
  });

  it("угрозы — впереди толпы: при потолке голосов режутся последние", () => {
    const ids = planCueSounds(cues({ kills: 5, playerHit: 1, fuses: 1, xp: 3, weapons: { knife: 2 } }), 4).map((request) => request.id);
    expect(ids.indexOf("hurt")).toBeLessThan(ids.indexOf("knife"));
    expect(ids.indexOf("fuseTick")).toBeLessThan(ids.indexOf("popSmall"));
    expect(ids.at(-1)).toBe("gem");
  });
});

describe("сцены и громкость", () => {
  it("сцена следует за экраном и фазой забега", () => {
    expect(sceneFor("lobby", false, "idle")).toBe("lobby");
    expect(sceneFor("stress", false, "idle")).toBe("silent");
    expect(sceneFor("run", true, "running")).toBe("run");
    expect(sceneFor("run", true, "levelUp")).toBe("choice");
    // Настройки, открытые с паузы, — пауза забега, а не главная.
    expect(sceneFor("settings", true, "paused")).toBe("pause");
    expect(sceneFor("run", true, "finished")).toBe("finished");
  });

  it("регулятор громкости логарифмический и тихий на старте", () => {
    expect(volumeCurve(0)).toBe(0);
    expect(volumeCurve(100)).toBe(1);
    expect(volumeCurve(50)).toBeLessThan(0.35);
    expect(volumeCurve(DEFAULT_VOLUMES.master)).toBeLessThan(0.5);
  });

  describe("настройки прошлой сборки", () => {
    beforeEach(() => {
      initShell({
        adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
        capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
        storage: memoryStorage({
          "bh.settings.v1": JSON.stringify({ screenMode: null, sound: false, music: true, haptics: true }),
        }),
        analytics: () => undefined,
        build: { version: "test", contentHash: "", platform: "web" },
      });
    });

    it("выключенный игроком звук не заигрывает после обновления", () => {
      useSettings.getState().hydrate("normal");
      expect(useSettings.getState().volumes).toEqual({ ...DEFAULT_VOLUMES, effects: 0, ui: 0 });
    });
  });
});
