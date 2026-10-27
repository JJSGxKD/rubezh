import { beforeEach, describe, expect, it } from "vitest";
import { createNoopPlatformUi, type KeyValueStorage, type PlatformAdapter } from "@bh/shared-types";
import type { BossSnapshot, RunCues } from "@bh/core-game";
import { volumeCurve } from "../src/audio/audio-engine";
import { DEFAULT_VOLUMES, bossPhaseRaised } from "../src/audio";
import { LAB_OVERRIDES_KEY, readLabOverrides, recipeSchema } from "../src/audio/lab-overrides";
import { BUSES, SOUND_RECIPES, UI_SOUNDS } from "../src/audio/recipes";
import { gemNotes, planCueSounds, revealRate } from "../src/audio/sound-director";
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
    freeze: 0,
    explosions: 0,
    explosionsNear: 0,
    strikes: 0,
    kills: 0,
    eliteKills: 0,
    eliteSpawns: 0,
    bossSpawns: 0,
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

  it("рецепта «Очага» нет, а старая правка с его id не ломает чтение", () => {
    expect(Object.hasOwn(SOUND_RECIPES, "hearth")).toBe(false);
    const storage = memoryStorage({
      [LAB_OVERRIDES_KEY]: JSON.stringify({
        uiTap: { ...SOUND_RECIPES.uiTap, level: 0.2 },
        hearth: { ...SOUND_RECIPES.spark },
      }),
    });
    expect(Object.keys(readLabOverrides(storage))).toEqual(["uiTap"]);
  });
});

describe("план звуков забега", () => {
  it("на пачку убийств — не больше трёх хлопков вразбивку", () => {
    const pops = planCueSounds(cues({ kills: 40 }), 0).filter((request) => request.id === "popSmall");
    expect(pops).toHaveLength(3);
    expect(pops.map((request) => request.options.delay)).toEqual([0, 0.035, 0.07]);
  });

  it("атаки врагов не звучат — только попадание по игроку; «Гроза» звучит ударом, а не срабатыванием", () => {
    const attacks = planCueSounds(cues({ explosions: 2, explosionsNear: 1, fuses: 1, dashWarns: 1, dashes: 1, enemyShots: 1 }), 0);
    expect(attacks).toEqual([]);
    expect(planCueSounds(cues({ playerHit: 1, explosionsNear: 1 }), 0).map((request) => request.id)).toEqual(["hurt"]);
    const storm = planCueSounds(cues({ weapons: { storm: 1, spark: 1 } }), 0).map((request) => request.id);
    expect(storm).toEqual(["spark"]);
    expect(planCueSounds(cues({ strikes: 1 }), 0).map((request) => request.id)).toEqual(["storm"]);
  });

  it("заморозка звучит колокольчиками на шине наград, динамит — своим звуком", () => {
    expect(planCueSounds(cues({ freeze: 1 }), 0).map((request) => request.id)).toEqual(["freeze"]);
    expect(planCueSounds(cues({ freeze: 1, dynamite: 1 }), 0).map((request) => request.id)).toEqual(["dynamite", "freeze"]);
    expect(SOUND_RECIPES.freeze.bus).toBe("rewards");
    expect(SOUND_RECIPES.freeze.layers.filter((layer) => layer.kind === "bell")).toHaveLength(3);
  });

  it("«Очаг» тактом ауры не звучит даже при большом счёте; остальное оружие звучит", () => {
    expect(planCueSounds(cues({ weapons: { hearth: 3 } }), 0)).toEqual([]);
    expect(planCueSounds(cues({ weapons: { hearth: 1, spark: 1 } }), 0).map((request) => request.id)).toEqual(["spark"]);
    for (const id of ["spark", "knife", "wardstone", "sting"]) {
      const ids = planCueSounds(cues({ weapons: { [id]: 1 } }), 0).map((request) => request.id);
      expect(ids, id).toEqual([id]);
    }
  });

  it("босс звучит своим рогом, а не рогом элиты; элита рядом с боссом — своим", () => {
    expect(planCueSounds(cues({ eliteSpawns: 1, bossSpawns: 1 }), 0).map((request) => request.id)).toEqual(["bossArrive"]);
    expect(planCueSounds(cues({ eliteSpawns: 2, bossSpawns: 1 }), 0).map((request) => request.id)).toEqual(["bossArrive", "eliteHorn"]);
    expect(planCueSounds(cues({ eliteSpawns: 1 }), 0).map((request) => request.id)).toEqual(["eliteHorn"]);
  });

  it("смена фазы босса звучит на росте фазы того же босса, а не на его выходе", () => {
    const boss = (phase: number, enemyId = "boss_seer"): BossSnapshot => ({ enemyId, hp: 100, maxHp: 100, phase, phases: 3 });
    expect(bossPhaseRaised(null, boss(0))).toBe(false);
    expect(bossPhaseRaised(boss(0), boss(0))).toBe(false);
    expect(bossPhaseRaised(boss(0), boss(1))).toBe(true);
    expect(bossPhaseRaised(boss(1), null)).toBe(false);
    expect(bossPhaseRaised(boss(2), boss(1, "boss_other"))).toBe(false);
  });

  it("награды сундука звенят лесенкой вверх и не уходят выше октавы", () => {
    const rates = [0, 1, 2, 3, 4, 5, 6, 9].map(revealRate);
    expect(rates[0]).toBe(1);
    for (let i = 1; i < 6; i++) expect(rates[i] ?? 0).toBeGreaterThan(rates[i - 1] ?? 0);
    expect(Math.max(...rates)).toBe(2);
  });

  it("важное — впереди толпы: при потолке голосов режутся последние", () => {
    const ids = planCueSounds(cues({ kills: 5, playerHit: 1, eliteSpawns: 1, xp: 3, weapons: { knife: 2 } }), 4).map((request) => request.id);
    expect(ids.indexOf("hurt")).toBeLessThan(ids.indexOf("knife"));
    expect(ids.indexOf("eliteHorn")).toBeLessThan(ids.indexOf("popSmall"));
    expect(ids.at(-1)).toBe("gem");
  });

  it("опыт — лесенкой: серия поднимается, наверху не залипает на одной ноте", () => {
    const rates = Array.from({ length: 9 }, (_, step) => gemNotes(1, step)[0]?.rate ?? 0);
    for (let i = 1; i < 6; i++) expect(rates[i]).toBeGreaterThan(rates[i - 1] ?? 0);
    expect(rates[5]).toBeCloseTo(2, 9);
    // После вершины — чередование двух верхних ступеней, а не одна нота.
    expect(new Set(rates.slice(5).map((rate) => rate.toFixed(4))).size).toBe(2);
  });

  it("крупный сбор — арпеджио с потолком нот, одиночный кристалл — одна нота", () => {
    expect(gemNotes(1, 0)).toHaveLength(1);
    const burst = gemNotes(500, 0);
    expect(burst).toHaveLength(6);
    expect(burst.map((note) => note.delay)).toEqual([0, 0.04, 0.08, 0.12, 0.16, 0.2]);
    expect(gemNotes(0, 3)).toEqual([]);
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

  describe("настройки сборки с музыкой", () => {
    beforeEach(() => {
      initShell({
        adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
        capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
        storage: memoryStorage({
          "bh.settings.v1": JSON.stringify({
            screenMode: "fullscreen",
            volumes: { master: 40, effects: 70, ui: 50, music: 55 },
            haptics: false,
          }),
        }),
        analytics: () => undefined,
        build: { version: "test", contentHash: "", platform: "web" },
      });
    });

    it("громкость музыки отбрасывается, а остальные настройки игрока не сбрасываются", () => {
      useSettings.getState().hydrate("normal");
      const state = useSettings.getState();
      expect(state.volumes).toEqual({ master: 40, effects: 70, ui: 50 });
      // Сброс настроек выглядел бы так: вибрация вернулась бы к умолчанию.
      expect(state.haptics).toBe(false);
    });
  });
});
