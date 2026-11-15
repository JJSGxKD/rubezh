import { beforeEach, describe, expect, it } from "vitest";
import { createNoopPlatformUi, type HapticType, type PlatformAdapter } from "@bh/shared-types";
import type { RunCues } from "@bh/core-game";
import { recipeSchema } from "../src/audio/lab-overrides";
import { BUSES, SOUND_RECIPES } from "../src/audio/recipes";
import { planCueSounds } from "../src/audio/sound-director";
import { HAPTIC_RULES, hapticForCues, resetHaptics } from "../src/state/haptics";
import { useSettings } from "../src/state/settings";
import { initShell } from "../src/state/shell";
import team from "../src/i18n/ru-team.json";

// Звук и вибрация Карачуна (Р205, tasks/T-0426): холодный выдох предвестия и тяжёлое касание.

const felt: HapticType[] = [];

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
    weapons: {},
    ...patch,
  };
}

function ids(patch: Partial<RunCues>): string[] {
  return planCueSounds(cues(patch), 0).map((request) => request.id);
}

describe("план звуков Карачуна", () => {
  it("предвестие звучит раньше рогов элиты и босса", () => {
    expect(ids({ stalkerOmens: 1, eliteSpawns: 2, bossSpawns: 1 })).toEqual(["stalkerOmen", "bossArrive", "eliteHorn"]);
  });

  it("касание — обычное попадание, затем глухой удар", () => {
    expect(ids({ stalkerTouches: 1, playerHit: 1 })).toEqual(["hurt", "stalkerStrike"]);
  });

  it("без сигналов Карачуна план прежний", () => {
    const typical = { playerHit: 1, eliteSpawns: 1, kills: 5, xp: 4, weapons: { spark: 2 } };
    expect(ids(typical)).toEqual(ids({ ...typical, stalkerOmens: 0, stalkerTouches: 0 }));
    expect(ids(typical)).toEqual(["hurt", "eliteHorn", "spark", "popSmall", "popSmall", "popSmall", "gem", "gem", "gem"]);
  });
});

describe("рецепты Карачуна", () => {
  it("проходят схему лаборатории и подписаны", () => {
    for (const id of ["stalkerOmen", "stalkerStrike"] as const) {
      const recipe = SOUND_RECIPES[id];
      expect(recipeSchema.safeParse(recipe).success, id).toBe(true);
      expect(BUSES[recipe.bus], id).toBeDefined();
    }
    expect(team["soundLab.sound.stalkerOmen"]).toBe("Карачун: предвестие");
    expect(team["soundLab.sound.stalkerStrike"]).toBe("Карачун: касание");
  });

  it("предвестие — на шине угроз, один голос, пауза не меньше секунды, около полутора секунд", () => {
    const omen = SOUND_RECIPES.stalkerOmen;
    expect(omen.bus).toBe("threats");
    expect(omen.voices).toBe(1);
    expect(omen.gap).toBeGreaterThanOrEqual(1);
    expect(omen.dur).toBeGreaterThanOrEqual(1.5);
    expect(omen.dur).toBeLessThanOrEqual(1.8);
  });

  it("касание — на шине игрока, не длиннее 0,4 с", () => {
    expect(SOUND_RECIPES.stalkerStrike.bus).toBe("player");
    expect(SOUND_RECIPES.stalkerStrike.dur).toBeLessThanOrEqual(0.4);
  });
});

describe("вибрация Карачуна", () => {
  beforeEach(() => {
    felt.length = 0;
    resetHaptics();
    initShell({
      adapter: { ui: createNoopPlatformUi(), haptic: (type: HapticType) => felt.push(type) } as unknown as PlatformAdapter,
      capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
      storage: undefined,
      analytics: () => undefined,
      build: { version: "test", contentHash: "", platform: "web" },
    });
    useSettings.setState({ haptics: true });
  });

  it("правила: предвестие — предупреждение раз в 1500 мс, касание — тяжёлая раз в 500 мс", () => {
    expect(HAPTIC_RULES.stalkerOmen).toEqual({ type: "warning", minIntervalMs: 1500 });
    expect(HAPTIC_RULES.stalkerTouch).toEqual({ type: "heavy", minIntervalMs: 500 });
  });

  it("касание важнее динамита, предвестие — после динамита и взрыва, перед элитой", () => {
    expect(hapticForCues(cues({ stalkerTouches: 1, dynamite: 1 }), 0)).toBe("stalkerTouch");
    expect(hapticForCues(cues({ stalkerOmens: 1, eliteSpawns: 1 }), 5000)).toBe("stalkerOmen");
    expect(hapticForCues(cues({ stalkerOmens: 1, dynamite: 1 }), 10000)).toBe("dynamite");
    expect(hapticForCues(cues({ stalkerOmens: 1, explosionsNear: 1 }), 15000)).toBe("blast");
    expect(felt).toEqual(["heavy", "warning", "heavy", "rigid"]);
  });

  it("выключенная вибрация молчит", () => {
    useSettings.setState({ haptics: false });
    expect(hapticForCues(cues({ stalkerTouches: 1, stalkerOmens: 1 }), 0)).toBeNull();
    expect(felt).toEqual([]);
  });
});
