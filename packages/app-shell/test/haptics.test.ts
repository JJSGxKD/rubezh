import { beforeEach, describe, expect, it } from "vitest";
import { createNoopPlatformUi, type HapticType, type PlatformAdapter } from "@bh/shared-types";
import type { RunCues } from "@bh/core-game";
import { haptic, hapticForCues, resetHaptics } from "../src/state/haptics";
import { useSettings } from "../src/state/settings";
import { initShell } from "../src/state/shell";

// Вибрация на действия и события забега: один переключатель и ограничение частоты.

const felt: HapticType[] = [];

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

describe("вибрация", () => {
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

  it("молчит, если игрок выключил вибрацию", () => {
    useSettings.setState({ haptics: false });
    expect(haptic("tap", 0)).toBe(false);
    expect(felt).toEqual([]);
  });

  it("не чаще интервала события: толпа не превращает телефон в электробритву", () => {
    expect(haptic("hit", 0)).toBe(true);
    expect(haptic("hit", 100)).toBe(false);
    expect(haptic("hit", 300)).toBe(true);
    expect(felt).toEqual(["light", "light"]);
  });

  it("два разных удара ближе порога сливаются в один", () => {
    expect(haptic("tap", 1000)).toBe(true);
    expect(haptic("select", 1010)).toBe(false);
    expect(haptic("select", 1050)).toBe(true);
  });

  it("из пачки сигналов выбирает одно самое важное", () => {
    expect(hapticForCues(cues({ playerHit: 3, dynamite: 1, heal: 1 }), 0)).toBe("dynamite");
    expect(hapticForCues(cues({ playerHit: 3, eliteSpawns: 1 }), 5000)).toBe("eliteSpawn");
    expect(hapticForCues(cues({ kills: 40, xp: 30, weapons: { spark: 5 } }), 9000)).toBeNull();
    expect(felt).toEqual(["heavy", "warning"]);
  });
});
