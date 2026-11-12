import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestrictionsHooks } from "../src/modules/restrictions/restrictions-hooks.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import type { SeasonBoardEntry, SeasonBoardStore } from "../src/modules/seasons/season-board.store.js";
import { SeasonsProjection } from "../src/modules/seasons/seasons-projection.js";
import { SeasonSchedule } from "../src/modules/seasons/seasons-schedule.js";
import type { SeasonsRepository } from "../src/modules/seasons/seasons.repository.js";
import { SETTINGS, type SettingValue } from "../src/modules/settings/setting-catalog.js";
import type { SettingsReader } from "../src/modules/settings/settings.service.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Смена `rating.points-from` на идущую неделю (tasks/T-0446, Р212): таблица
 * недели пересобирается сама, под замком Redis, один раз на ключ доски.
 */

const POINTS_FROM = SETTINGS.ratingPointsFrom.key;
/** Четверг; идёт сезон 2026-11-09. */
const NOW = new Date("2026-11-12T12:00:00Z");

/** Панель с сообщением об изменении, как у `SettingsService`: `set` зовёт слушателей. */
function reactiveSettings(initial: Record<string, SettingValue>) {
  const inner = panelSettings(initial);
  const listeners: ((changed: readonly string[]) => void)[] = [];
  const settings: SettingsReader & { set(key: string, value: SettingValue): void } = {
    get: (setting) => inner.get(setting),
    onChange: (listener) => void listeners.push(listener),
    set: (key, value) => {
      inner.set(key, value);
      for (const listener of listeners) listener([key]);
    },
  };
  return settings;
}

function setup(options: { lock?: "OK" | null; weekBests?: () => Promise<{ accountId: string; score: number }[]> } = {}) {
  const settings = reactiveSettings({ [SETTINGS.seasonsStartDate.key]: 20261102, [POINTS_FROM]: 20261116 });
  const replaced: string[] = [];
  const store = {
    replace: async (season: { key: string }, difficulty: string, _entries: readonly SeasonBoardEntry[], board = "common") => {
      replaced.push(`${season.key}:${board}:${difficulty}`);
    },
  };
  const repository = { weekBests: vi.fn(options.weekBests ?? (async () => [{ accountId: "a", score: 1_200 }])) };
  const redis = { set: vi.fn(async () => options.lock ?? "OK"), eval: vi.fn(async () => 1) };
  const rating = { boardsFor: async () => [], separate: async () => [] as string[] };
  const restrictions = { restrictedAccounts: async () => [] as string[], status: async () => null };
  const projection = new SeasonsProjection(
    new SeasonSchedule(settings),
    store as unknown as SeasonBoardStore,
    repository as unknown as SeasonsRepository,
    new RunsHooks(),
    new RestrictionsHooks(),
    restrictions as never,
    rating as never,
    redis as never,
  );
  const rebuild = vi.spyOn(projection, "rebuild");
  projection.onModuleInit();
  return { settings, projection, rebuild, redis, replaced, repository };
}

/** Слушатель не ждёт пересборки: даём отработать цепочке промисов. */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
};

describe("SeasonsProjection: пересборка таблицы при переходе недели на очки", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("понедельник идущей недели: один rebuild, обе таблицы пишутся под ключ pts:, замок снят по токену", async () => {
    const { settings, rebuild, redis, replaced } = setup();
    settings.set(POINTS_FROM, 20261109);
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
    await flush();
    expect(replaced.length).toBeGreaterThan(0);
    expect(replaced.every((key) => key.startsWith("pts:2026-11-09:"))).toBe(true);
    expect(replaced.some((key) => key.includes(":full:")) && replaced.some((key) => key.includes(":common:"))).toBe(true);
    // замок берётся с токеном и снимается им же
    const taken = redis.set.mock.calls[0] as unknown as unknown[];
    expect(taken[0]).toBe("seasons:board-switch:lock");
    expect(taken.slice(2)).toEqual(["PX", 120_000, "NX"]);
    const released = redis.eval.mock.calls[0] as unknown as unknown[];
    expect(released.slice(2)).toEqual(["seasons:board-switch:lock", taken[1]]);
  });

  it("следующий понедельник: идущий сезон остаётся по времени — пересборки нет", async () => {
    const { settings, rebuild, redis } = setup();
    settings.set(POINTS_FROM, 20261116);
    await flush();
    expect(rebuild).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("другой ключ настроек пересборку не запускает", async () => {
    const { settings, rebuild, redis } = setup();
    settings.set(SETTINGS.ratingSinceDate.key, 20261104);
    await flush();
    expect(rebuild).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("замок занят другой репликой — ничего не делаем и чужой замок не снимаем", async () => {
    const { settings, rebuild, redis } = setup({ lock: null });
    settings.set(POINTS_FROM, 20261109);
    await flush();
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(rebuild).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("повторное событие с тем же ключом доски на той же реплике второй пересборки не даёт", async () => {
    const { settings, rebuild } = setup();
    settings.set(POINTS_FROM, 20261109);
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
    await flush();
    settings.set(POINTS_FROM, 20261109);
    await flush();
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it("rebuild упал: замок снят, из слушателя исключение не ушло, следующая смена пробует снова", async () => {
    let fail = true;
    const { settings, rebuild, redis } = setup({
      weekBests: async () => {
        if (fail) throw new Error("база недоступна");
        return [];
      },
    });
    expect(() => settings.set(POINTS_FROM, 20261109)).not.toThrow();
    await vi.waitFor(() => expect(redis.eval).toHaveBeenCalledTimes(1));
    expect(rebuild).toHaveBeenCalledTimes(1);
    fail = false;
    settings.set(POINTS_FROM, 20261109);
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(2));
  });
});
