import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { TelegramAffiliateMarker } from "../src/modules/attribution/telegram-affiliate.marker.js";
import { parseStartParam, type StartChannel } from "../src/modules/attribution/start-param.js";
import { AuthHooks, type LoginEvent } from "../src/modules/auth/auth-hooks.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryTelegramAffiliate } from "./helpers/memory-telegram-affiliate.js";

/**
 * Метка партнёрки Telegram (docs/35-stage4-plan.md Р97, T-0072): вход по `_tgr_<id>` на Telegram
 * ставит метку аккаунта один раз и навсегда. Проверяется то, где метку ставят зря или не ставят
 * вовсе: чужая площадка, повторный вход посреди работы, чужие виды параметра, занятый слот
 * источника, повтор с другим идентификатором и упавшая база.
 */

const NOW = Date.UTC(2026, 9, 13, 14, 5, 0);

function config(env: Record<string, string> = AUTH_ENV): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...env } as NodeJS.ProcessEnv);
}

function login(patch: Partial<LoginEvent> = {}, param = "_tgr_x9Y-z", channel: StartChannel = "miniapp"): LoginEvent {
  return {
    accountId: randomUUID(),
    platform: "telegram",
    place: "miniapp",
    startParam: parseStartParam(param, channel),
    created: false,
    at: new Date(NOW),
    ip: "203.0.113.57",
    userAgent: null,
    client: null,
    reason: "launch",
    ...patch,
  };
}

function setup(env: Record<string, string> = AUTH_ENV) {
  const marks = new MemoryTelegramAffiliate();
  const hooks = new AuthHooks();
  const marker = new TelegramAffiliateMarker(config(env), hooks, marks);
  return { marks, hooks, marker };
}

/** Строки лога модуля, разобранные: уровень тесту не важен, важны имя события и поля. */
function captureLog(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  const record = (line: unknown): void => {
    if (typeof line === "string" && line.startsWith("{")) lines.push(JSON.parse(line) as Record<string, unknown>);
  };
  for (const level of ["log", "warn", "error", "debug", "verbose"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(record);
  return lines;
}

/** Журнал модуля — для проверки строк и чтобы тестовые прогоны не засоряли вывод. */
let lines: Record<string, unknown>[] = [];

beforeEach(() => {
  lines = captureLog();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("метка ставится при входе по ссылке партнёрки Telegram", () => {
  it("Mini App, слот свободен: метка с параметром как пришёл, идентификатором и временем входа", async () => {
    const { marks, marker } = setup();
    const event = login();

    expect(await marker.onLogin(event)).toEqual({ status: "marked" });

    expect(marks.marks.get(event.accountId)).toEqual({ startParam: "_tgr_x9Y-z", ref: "x9Y-z", markedAt: event.at });
  });

  it("`/start` бота — тоже вход: метка ставится", async () => {
    const { marks, marker } = setup();
    const event = login({ place: "channel" }, "_tgr_x9Y-z", "bot");

    expect(await marker.onLogin(event)).toEqual({ status: "marked" });
    expect(marks.marks.get(event.accountId)?.ref).toBe("x9Y-z");
  });

  it("уже играющему игроку метка тоже ставится: Р97 буквально, расхождение уйдёт в сверку по выписке", async () => {
    const { marks, marker } = setup();
    const event = login({ created: false });

    expect(await marker.onLogin(event)).toEqual({ status: "marked" });
    expect(marks.marks.has(event.accountId)).toBe(true);
  });

  it("второй приход с другим идентификатором метку не меняет: ни код, ни дату", async () => {
    const { marks, marker } = setup();
    const first = login();
    await marker.onLogin(first);

    const second = login({ accountId: first.accountId, at: new Date(NOW + 86_400_000) }, "_tgr_other");
    expect(await marker.onLogin(second)).toEqual({ status: "already" });

    expect(marks.marks.get(first.accountId)).toEqual({ startParam: "_tgr_x9Y-z", ref: "x9Y-z", markedAt: first.at });
  });

  it("слот занят приглашением друга или партнёром: метки нет, исход называет слот", async () => {
    const { marks, marker } = setup();
    const invited = login();
    const partnered = login();
    marks.slots.set(invited.accountId, "referral");
    marks.slots.set(partnered.accountId, "partner");

    expect(await marker.onLogin(invited)).toEqual({ status: "slot_taken", slot: "referral" });
    expect(await marker.onLogin(partnered)).toEqual({ status: "slot_taken", slot: "partner" });

    expect(marks.marks.size).toBe(0);
  });

  it("граница длины: `_tgr_` и 59 знаков — это 64, предел Telegram, и метка ставится", async () => {
    const { marks, marker } = setup();
    const id = "a".repeat(59);
    const event = login({ place: "channel" }, `_tgr_${id}`, "bot");

    expect(await marker.onLogin(event)).toEqual({ status: "marked" });

    const mark = marks.marks.get(event.accountId);
    expect(mark?.startParam).toHaveLength(64);
    expect(mark?.ref).toBe(id);
  });
});

describe("метка не ставится", () => {
  it.each([
    ["клик кампании", "c-Ab12Cd34"],
    ["ссылка дружбы", "f-Ab12Cd34Ef"],
    ["приглашение друга", "invite"],
    ["кнопка уведомления", "n-friend_request"],
    ["пустой параметр", ""],
    ["`_tgr_` без идентификатора", "_tgr_"],
    ["кириллица в идентификаторе", "_tgr_аб"],
  ])("%s: вход пропускается, репозиторий не зовётся", async (_name, param) => {
    const { marks, marker } = setup();

    expect(await marker.onLogin(login({}, param))).toEqual({ status: "skipped" });

    expect(marks.markCalls).toBe(0);
    expect(marks.marks.size).toBe(0);
  });

  it("повторный вход посреди работы — не запуск: метка не ставится", async () => {
    const { marks, marker } = setup();

    expect(await marker.onLogin(login({ reason: "reauth" }))).toEqual({ status: "skipped" });
    expect(marks.markCalls).toBe(0);
  });

  it.each(["max", "vk"] as const)("на площадке %s `_tgr_x9Y-z` — просто чужой текст: метка не ставится", async (platform) => {
    const { marks, marker } = setup();

    expect(await marker.onLogin(login({ platform }))).toEqual({ status: "skipped" });
    expect(marks.markCalls).toBe(0);
  });
});

describe("слушатель входа", () => {
  it("после onModuleInit вход, объявленный через AuthHooks, доходит до репозитория", async () => {
    const { marks, hooks, marker } = setup();
    marker.onModuleInit();
    const event = login();

    await hooks.emit(event);

    expect(marks.marks.get(event.accountId)?.ref).toBe("x9Y-z");
  });

  it("упавший репозиторий не роняет вход: emit разрешается, метка поставится при следующем приходе", async () => {
    const { marks, hooks, marker } = setup();
    marker.onModuleInit();
    marks.failing = true;
    const event = login();

    await expect(hooks.emit(event)).resolves.toBeUndefined();
    expect(marks.marks.size).toBe(0);

    marks.failing = false;
    await hooks.emit(event);
    expect(marks.marks.has(event.accountId)).toBe(true);
  });

  it("ошибка базы слушателем не глотается: её запишет AuthHooks как login_listener_failed", async () => {
    const { marks, marker } = setup();
    marks.failing = true;

    await expect(marker.onLogin(login())).rejects.toThrow("база недоступна");
  });

  it("при выключенном входе слушатель не подписывается", async () => {
    const { marks, hooks, marker } = setup({ NODE_ENV: "test" });
    marker.onModuleInit();

    await hooks.emit(login());

    expect(marks.markCalls).toBe(0);
  });

  it("в лог модуля attribution пишутся метка и занятый слот; повтор — тишина", async () => {
    const { marks, marker } = setup();
    const placed = login({ created: true });
    const blocked = login({ place: "channel" });
    marks.slots.set(blocked.accountId, "partner");

    await marker.onLogin(placed);
    await marker.onLogin(blocked);
    await marker.onLogin(login({ accountId: placed.accountId }, "_tgr_other"));
    await marker.onLogin(login({}, "c-Ab12Cd34"));

    expect(lines).toEqual([
      { module: "attribution", event: "telegram_affiliate_marked", accountId: placed.accountId, ref: "x9Y-z", place: "miniapp", created: true },
      { module: "attribution", event: "telegram_affiliate_slot_taken", accountId: blocked.accountId, ref: "x9Y-z", place: "channel", created: false, slot: "partner" },
    ]);
  });
});
