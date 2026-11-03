import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type PlatformAdapter } from "@bh/shared-types";
import { CONTENT_HASH, RUN_SNAPSHOT_FORMAT, type RunEngine, type RunOptions, type RunSession, type RunSnapshot } from "@bh/core-game";

// Слабое устройство в наборе забега (tasks/T-0196, решение 4, Р67): класс
// определяется один раз на старте, ложится в набор только для слабого, а
// продолженный забег набор не передаёт вовсе.

const mocks = vi.hoisted(() => ({ load: vi.fn(), deviceClass: vi.fn() }));

vi.mock("@bh/core-game", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bh/core-game")>()),
  loadRunEngine: mocks.load,
}));

vi.mock("../src/state/device", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/state/device")>()),
  deviceClassOf: mocks.deviceClass,
}));

const { useRun } = await import("../src/state/run");
const { initShell } = await import("../src/state/shell");

function engineCapturing(options: RunOptions[]): RunEngine {
  const session = {
    on: () => () => undefined,
    restart: () => undefined,
    destroy: () => undefined,
    snapshot: () => null,
  } as unknown as RunSession;
  return {
    start: (runOptions: RunOptions) => {
      options.push(runOptions);
      return session;
    },
  };
}

const base = { container: {} as HTMLElement, startingWeaponId: "spark", mapId: "frontier", difficultyId: "normal" as const };

const SNAPSHOT: RunSnapshot = {
  format: RUN_SNAPSHOT_FORMAT,
  contentHash: CONTENT_HASH,
  runId: "run-1",
  seed: 42,
  mapId: "frontier",
  difficultyId: "hard",
  startingWeaponId: "knife",
  summary: { survivalSec: 95, level: 6, weapons: [{ id: "knife", level: 2 }], passives: [] },
  world: { version: 1 },
};

beforeEach(() => {
  mocks.load.mockReset();
  mocks.deviceClass.mockReset();
  initShell({
    adapter: { ui: createNoopPlatformUi(), haptic: () => undefined } as unknown as PlatformAdapter,
    capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
    storage: undefined,
    analytics: () => undefined,
    build: { version: "test", contentHash: "", platform: "web" },
  });
  useRun.getState().stop();
});

describe("класс устройства в наборе забега", () => {
  it("слабое устройство кладёт deviceClass: light вместе с уровнем аккаунта", async () => {
    const started: RunOptions[] = [];
    mocks.load.mockResolvedValue(engineCapturing(started));
    mocks.deviceClass.mockReturnValue("light");

    await useRun.getState().start(base);

    expect(started[0]?.loadout).toMatchObject({ deviceClass: "light", accountLevel: expect.any(Number) });
  });

  it("обычное устройство ключа deviceClass в наборе не пишет", async () => {
    const started: RunOptions[] = [];
    mocks.load.mockResolvedValue(engineCapturing(started));
    mocks.deviceClass.mockReturnValue("standard");

    await useRun.getState().start(base);

    expect(started[0]?.loadout).toBeDefined();
    expect(started[0]?.loadout).not.toHaveProperty("deviceClass");
  });

  it("продолженный забег набор не передаёт — класс устройства уже внутри снимка", async () => {
    const started: RunOptions[] = [];
    mocks.load.mockResolvedValue(engineCapturing(started));
    mocks.deviceClass.mockReturnValue("light");

    await useRun.getState().start({ ...base, resume: SNAPSHOT });

    expect(started[0]?.loadout).toBeUndefined();
  });
});
