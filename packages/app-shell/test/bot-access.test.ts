import { beforeEach, describe, expect, it } from "vitest";
import type { PlatformAdapter } from "@bh/shared-types";
import type { ApiResult } from "../src/state/api-request";
import { ASK_AGAIN_AFTER_MS, BOT_ACCESS_ASKS_KEY, MAX_ASKS, shouldOfferBotAccess, useBotAccess } from "../src/state/bot-access";
import { dismissBotAccess, hydrateBotAccess, loadBotAccess, requestBotAccess, type BotAccessApi } from "../src/state/bot-access-sync";
import { useShell } from "../src/state/shell";

// Разрешение боту писать (tasks/T-0010): после первого забега зовём один раз,
// отказ возвращает просьбу не раньше чем через 14 дней и не больше трёх раз.
// Кто решает, что разрешение уже есть, — сервер; «не знаем» — не спрашиваем.

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const DAY = 86_400_000;
const base = { runs: 1, canMessage: false as boolean | null, supported: true, asks: { count: 0, lastAt: null as number | null }, now: NOW };

describe("когда предлагать разрешение", () => {
  it("первый раз после первого забега — да", () => {
    expect(shouldOfferBotAccess(base)).toBe(true);
  });

  it("нет забегов — нет", () => {
    expect(shouldOfferBotAccess({ ...base, runs: 0 })).toBe(false);
  });

  it("разрешение уже есть — нет", () => {
    expect(shouldOfferBotAccess({ ...base, canMessage: true })).toBe(false);
  });

  it("сервер не ответил (null) — не знаем, не спрашиваем", () => {
    expect(shouldOfferBotAccess({ ...base, canMessage: null })).toBe(false);
  });

  it("площадка запроса не умеет — нет", () => {
    expect(shouldOfferBotAccess({ ...base, supported: false })).toBe(false);
  });

  it("три показа уже было — больше нет, как бы давно ни было", () => {
    expect(MAX_ASKS).toBe(3);
    expect(shouldOfferBotAccess({ ...base, asks: { count: 3, lastAt: NOW - 100 * DAY } })).toBe(false);
  });

  it("последний показ 13 дней назад — нет, 14 — да", () => {
    expect(ASK_AGAIN_AFTER_MS).toBe(14 * DAY);
    expect(shouldOfferBotAccess({ ...base, asks: { count: 1, lastAt: NOW - 13 * DAY } })).toBe(false);
    expect(shouldOfferBotAccess({ ...base, asks: { count: 1, lastAt: NOW - 14 * DAY } })).toBe(true);
  });
});

const events: [string, unknown][] = [];
let storageValues: Map<string, string>;

function setup(request: PlatformAdapter["requestBotMessages"]): void {
  storageValues = new Map();
  events.length = 0;
  useShell.setState({
    adapter: { requestBotMessages: request } as unknown as PlatformAdapter,
    analytics: (event: string, payload: unknown) => void events.push([event, payload]),
    storage: {
      get: (key: string) => storageValues.get(key) ?? null,
      set: (key: string, value: string) => void storageValues.set(key, value),
      remove: (key: string) => void storageValues.delete(key),
    },
  } as never);
  useBotAccess.setState({ canMessage: false, asks: { count: 0, lastAt: null } });
}

beforeEach(() => setup(undefined));

describe("запрос разрешения", () => {
  it("allowed — разрешение считается полученным сразу, счёт не растёт, оба события", async () => {
    setup(async () => "allowed");
    await expect(requestBotAccess("lobby", NOW)).resolves.toBe("allowed");
    expect(useBotAccess.getState().canMessage).toBe(true);
    expect(useBotAccess.getState().asks.count).toBe(0);
    expect(events).toEqual([
      ["bot_access_offered", { place: "lobby" }],
      ["bot_access_result", { place: "lobby", result: "allowed" }],
    ]);
  });

  it("declined — счёт +1, время запомнено и записано в хранилище", async () => {
    setup(async () => "declined");
    await expect(requestBotAccess("settings", NOW)).resolves.toBe("declined");
    expect(useBotAccess.getState().canMessage).toBe(false);
    expect(useBotAccess.getState().asks).toEqual({ count: 1, lastAt: NOW });
    expect(JSON.parse(storageValues.get(BOT_ACCESS_ASKS_KEY) ?? "null")).toEqual({ count: 1, lastAt: NOW });
    expect(events[1]).toEqual(["bot_access_result", { place: "settings", result: "declined" }]);
  });

  it("площадка запроса не умеет — «unavailable», без событий и без счёта", async () => {
    setup(undefined);
    await expect(requestBotAccess("lobby", NOW)).resolves.toBe("unavailable");
    expect(events).toEqual([]);
    expect(useBotAccess.getState().asks.count).toBe(0);
  });

  it("«Не сейчас» — счёт +1 без обращения к площадке и без событий", () => {
    setup(async () => {
      throw new Error("площадку звать не должны");
    });
    dismissBotAccess(NOW);
    expect(useBotAccess.getState().asks).toEqual({ count: 1, lastAt: NOW });
    expect(events).toEqual([]);
    expect(JSON.parse(storageValues.get(BOT_ACCESS_ASKS_KEY) ?? "null")).toEqual({ count: 1, lastAt: NOW });
  });

  it("счёт переживает перезапуск: читается из хранилища, битое значение сбрасывается", () => {
    setup(undefined);
    storageValues.set(BOT_ACCESS_ASKS_KEY, JSON.stringify({ count: 2, lastAt: NOW - DAY }));
    hydrateBotAccess();
    expect(useBotAccess.getState().asks).toEqual({ count: 2, lastAt: NOW - DAY });

    storageValues.set(BOT_ACCESS_ASKS_KEY, "не json");
    hydrateBotAccess();
    expect(useBotAccess.getState().asks).toEqual({ count: 0, lastAt: null });
  });
});

describe("ответ сервера", () => {
  const answer = (result: ApiResult<{ canMessage: boolean }>): BotAccessApi => ({ mine: async () => result });

  it("ответ кладётся в стор", async () => {
    useBotAccess.setState({ canMessage: null });
    await loadBotAccess(answer({ ok: true, data: { canMessage: true } }));
    expect(useBotAccess.getState().canMessage).toBe(true);
  });

  it("нет сети или отказ — остаётся «не знаем» (null), а не «нельзя»", async () => {
    useBotAccess.setState({ canMessage: null });
    await loadBotAccess(answer({ ok: false, failure: "offline" }));
    expect(useBotAccess.getState().canMessage).toBeNull();
  });
});
