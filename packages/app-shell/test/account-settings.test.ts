import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopPlatformUi, type KeyValueStorage, type PlatformAdapter } from "@bh/shared-types";
import { mergeSettings, SEED_AT, type AccountSettingValues, type IncomingSetting } from "../../../backend/api/src/modules/account-settings/account-settings.catalog.js";
import { noteAccountSetting, resetAccountSettingsForTests, syncAccountSettings } from "../src/state/account-settings";
import { useDiagnostics } from "../src/state/diagnostics";
import { useGraphics } from "../src/state/graphics";
import { useHints } from "../src/state/hints";
import { resetSessionForTests } from "../src/state/session";
import { initShell } from "../src/state/shell";

// Настройки аккаунта (docs/35-stage4-plan.md WP29): при входе приходит
// выбранное на другом устройстве, выбранное здесь уходит туда. Сеть
// подменяется, но сливает её «сервер» настоящей функцией бэкенда — так тест
// ловит и расхождение формата запроса. Сессия — настоящая.

const SERVER_NOW = Date.UTC(2026, 8, 29, 12);
const HOUR = 3_600_000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SESSION = {
  data: {
    accessToken: "access",
    expiresInSec: 900,
    refreshToken: "refresh-token-refresh-token",
    account: { accountId: "acc", displayName: "Дым", photoUrl: null, createdAt: "2026-09-23T00:00:00.000Z", created: false },
  },
};

describe("настройки аккаунта на клиенте", () => {
  let storage: KeyValueStorage & { values: Record<string, string> };
  /** настройки на сервере по аккаунтам; `account` — чей токен сейчас в запросе */
  let servers: Record<string, AccountSettingValues>;
  let account: string;
  /** часы сервера идут вместе со временем теста от заданной точки */
  let serverBase: { server: number; device: number };
  const serverNow = (): number => serverBase.server + (Date.now() - serverBase.device);
  const setServerNow = (ms: number): void => {
    serverBase = { server: ms, device: Date.now() };
  };
  let posts: Record<string, IncomingSetting>[];
  /** задержать ответ на POST — чтобы выбрать что-то, пока запрос в пути */
  let holdPost: Promise<void> | null;

  function mount(options: { auth?: boolean; diagnosticsByDefault?: boolean } = {}): void {
    initShell({
      adapter: {
        ui: createNoopPlatformUi(),
        haptic: () => undefined,
        signedLaunchData: () => (options.auth === false ? null : "signed"),
        clientInfo: () => ({ platform: "android", version: "8.0" }),
      } as unknown as PlatformAdapter,
      capabilities: {
        platformAvailable: true,
        botUrl: "",
        diagnosticsByDefault: options.diagnosticsByDefault ?? false,
        ...(options.auth === false ? {} : { auth: { baseUrl: "" } }),
      },
      storage,
      analytics: () => undefined,
      build: { version: "test", contentHash: "abcd1234", platform: "web" },
    });
    useDiagnostics.getState().hydrate(options.diagnosticsByDefault ?? false);
    useGraphics.getState().hydrate();
    useHints.getState().hydrate();
  }

  beforeEach(() => {
    const values: Record<string, string> = {};
    storage = {
      values,
      get: (key) => values[key] ?? null,
      set: (key, value) => {
        values[key] = value;
      },
      remove: (key) => {
        delete values[key];
      },
    };
    servers = {};
    account = "acc";
    setServerNow(SERVER_NOW);
    posts = [];
    holdPost = null;
    resetSessionForTests();
    resetAccountSettingsForTests();
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url === "/api/v1/auth/telegram" && init.method === "POST") return json(200, SESSION);
      if (url !== "/api/v1/account/settings") return json(404, { error: { code: "not_found" } });
      const stored = servers[account] ?? {};
      if (init.method === "GET") return json(200, { data: { version: 1, values: stored } });
      const body = JSON.parse(String(init.body)) as { values: Record<string, IncomingSetting> };
      posts.push(body.values);
      if (holdPost !== null) await holdPost;
      servers[account] = mergeSettings(stored, body.values, serverNow()).values;
      return json(200, { data: { version: 1, values: servers[account], ignored: [] } });
    });
    mount();
  });

  afterEach(() => {
    resetAccountSettingsForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("выбранное на ПК приходит на телефон при входе, а графика устройства — нет", async () => {
    servers.acc = {
      "combat.damageNumbers": { value: false, at: SERVER_NOW - HOUR },
      "hints.seen": { value: ["move", "gems"], at: SERVER_NOW - HOUR },
      "testing.enabled": { value: true, at: SERVER_NOW - HOUR },
    };
    useGraphics.setState({ weaponEffects: false });
    await syncAccountSettings("acc");
    expect(useGraphics.getState()).toMatchObject({ damageNumbers: false, weaponEffects: false });
    expect(useHints.getState().seen).toEqual(["move", "gems"]);
    expect(useDiagnostics.getState().enabled).toBe(true);
    expect(posts).toHaveLength(0);
  });

  it("переключатели устройства на сервер не уходят", async () => {
    vi.useFakeTimers();
    await syncAccountSettings("acc");
    useGraphics.getState().toggle("weaponEffects");
    useDiagnostics.getState().toggle("fpsOverlay");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(posts).toHaveLength(0);
  });

  it("новое устройство с умолчаниями ничего не засевает и берёт выбранное раньше", async () => {
    servers.acc = { "combat.telegraphs": { value: false, at: SEED_AT } };
    await syncAccountSettings("acc");
    expect(posts).toHaveLength(0);
    expect(useGraphics.getState().telegraphs).toBe(false);
  });

  it("выбор со старой сборки уходит засевом: занимает пустой ключ, но не перебивает выбранное", async () => {
    servers.acc = { "combat.telegraphs": { value: true, at: SERVER_NOW - HOUR } };
    useGraphics.getState().applyAccount({ telegraphs: false, damageNumbers: false });
    useHints.getState().applyAccount(["move"]);
    useDiagnostics.getState().applyAccount({ enabled: true });
    await syncAccountSettings("acc");

    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({
      "combat.telegraphs": { value: false, seed: true },
      "combat.damageNumbers": { value: false, seed: true },
      "hints.seen": { value: ["move"], seed: true },
      "testing.enabled": { value: true, seed: true },
    });
    // Настоящий выбор с другого устройства остался и пришёл сюда.
    expect(useGraphics.getState()).toMatchObject({ telegraphs: true, damageNumbers: false });
    expect(servers.acc["combat.damageNumbers"]).toEqual({ value: false, at: SEED_AT });
    // Засев — один раз: следующий вход ничего не шлёт.
    resetAccountSettingsForTests();
    await syncAccountSettings("acc");
    expect(posts).toHaveLength(1);
  });

  it("умолчание сборки у диагностики засевом не уходит и остаётся умолчанием", async () => {
    mount({ diagnosticsByDefault: true });
    useDiagnostics.getState().toggle("fpsOverlay");
    await syncAccountSettings("acc");
    expect(posts).toHaveLength(0);
    expect(JSON.parse(storage.values["bh.diagnostics.v1"] ?? "{}")).toMatchObject({ enabled: null, recordRuns: null, fpsOverlay: true });
  });

  it("часы устройства на сутки вперёд не перебивают выбранное позже на другом устройстве", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SERVER_NOW + 24 * HOUR);
    setServerNow(SERVER_NOW);
    await syncAccountSettings("acc");
    noteAccountSetting("combat.telegraphs", false);
    vi.setSystemTime(SERVER_NOW + 24 * HOUR + 1_000);
    resetAccountSettingsForTests();
    await syncAccountSettings("acc");
    expect(servers.acc?.["combat.telegraphs"]).toEqual({ value: false, at: SERVER_NOW });

    // Через час на ПК с верными часами телеграфы включили снова.
    servers.acc = { "combat.telegraphs": { value: true, at: SERVER_NOW + HOUR } };
    vi.setSystemTime(SERVER_NOW + 26 * HOUR);
    resetAccountSettingsForTests();
    await syncAccountSettings("acc");
    expect(useGraphics.getState().telegraphs).toBe(true);
    expect(servers.acc["combat.telegraphs"]).toEqual({ value: true, at: SERVER_NOW + HOUR });
  });

  it("часы устройства отстают — свежий выбор всё равно побеждает и не откатывается", async () => {
    servers.acc = { "combat.damageNumbers": { value: false, at: SERVER_NOW - 5 * 60_000 } };
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(SERVER_NOW - 10 * 60_000);
    setServerNow(SERVER_NOW);
    await syncAccountSettings("acc");
    expect(useGraphics.getState().damageNumbers).toBe(false);

    useGraphics.getState().toggle("damageNumbers");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(posts).toHaveLength(1);
    expect(useGraphics.getState().damageNumbers).toBe(true);
    expect(servers.acc["combat.damageNumbers"]?.value).toBe(true);
  });

  it("изменения переключателями подряд уходят одним запросом", async () => {
    vi.useFakeTimers();
    await syncAccountSettings("acc");
    useGraphics.getState().toggle("telegraphs");
    useGraphics.getState().toggle("damageNumbers");
    useDiagnostics.getState().toggle("enabled");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(posts).toHaveLength(1);
    expect(Object.keys(posts[0] ?? {}).sort()).toEqual(["combat.damageNumbers", "combat.telegraphs", "testing.enabled"]);
    expect(servers.acc).toMatchObject({ "combat.telegraphs": { value: false }, "testing.enabled": { value: true } });
  });

  it("выбранное до входа не уходит раньше синхронизации, а уходит с ней", async () => {
    vi.useFakeTimers();
    useGraphics.getState().toggle("telegraphs");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(posts).toHaveLength(0);
    await syncAccountSettings("acc");
    expect(posts).toHaveLength(1);
    expect(servers.acc?.["combat.telegraphs"]?.value).toBe(false);
  });

  it("выбранное, пока запрос в пути, не откатывается ответом и уходит следующим", async () => {
    vi.useFakeTimers();
    await syncAccountSettings("acc");
    let release = (): void => undefined;
    holdPost = new Promise<void>((resolve) => {
      release = resolve;
    });
    useGraphics.getState().toggle("telegraphs");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(posts).toHaveLength(1);
    useGraphics.getState().toggle("telegraphs");
    holdPost = null;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(useGraphics.getState().telegraphs).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(posts).toHaveLength(2);
    expect(servers.acc?.["combat.telegraphs"]?.value).toBe(true);
  });

  it("усвоенное без сети складывается с усвоенным на другом устройстве", async () => {
    servers.acc = { "hints.seen": { value: ["gems", "dodge"], at: SERVER_NOW - HOUR } };
    useHints.getState().markSeen("move");
    await syncAccountSettings("acc");
    expect([...useHints.getState().seen].sort()).toEqual(["dodge", "gems", "move"]);
    expect([...((servers.acc["hints.seen"]?.value as string[] | undefined) ?? [])].sort()).toEqual(["dodge", "gems", "move"]);
  });

  it("другой аккаунт на том же устройстве не получает чужой выбор", async () => {
    vi.useFakeTimers();
    await syncAccountSettings("acc");
    useDiagnostics.getState().toggle("enabled");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(servers.acc?.["testing.enabled"]?.value).toBe(true);

    account = "other";
    servers.other = { "testing.enabled": { value: false, at: SERVER_NOW - HOUR } };
    useGraphics.getState().toggle("telegraphs");
    await syncAccountSettings("other");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(servers.other).toEqual({ "testing.enabled": { value: false, at: SERVER_NOW - HOUR } });
    expect(useDiagnostics.getState().enabled).toBe(false);
  });

  it("без входа в сборке ничего не отправляет", async () => {
    mount({ auth: false });
    useGraphics.getState().toggle("telegraphs");
    await syncAccountSettings("acc");
    expect(posts).toHaveLength(0);
  });
});
