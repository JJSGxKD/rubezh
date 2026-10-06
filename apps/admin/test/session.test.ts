import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AdminApi } from "../src/api/client";
import { can, createSessionStore } from "../src/state/session";
import { fakeFetch, IDENTITY, json } from "./helpers";

describe("сессия панели", () => {
  it("восстанавливает вход по cookie, а без неё показывает форму", async () => {
    const withCookie = createSessionStore(new AdminApi(fakeFetch(json(200, { data: IDENTITY })).fetch));
    await withCookie.getState().restore();
    expect(withCookie.getState().view).toEqual({ status: "ready", identity: IDENTITY });

    const without = createSessionStore(new AdminApi(fakeFetch(json(401, { error: { code: "unauthorized", message: "нет" } })).fetch));
    await without.getState().restore();
    expect(without.getState().view).toMatchObject({ status: "anonymous", notice: null });
  });

  it("выключенная панель и лежащий API — не форма входа, а причина", async () => {
    const store = createSessionStore(new AdminApi(fakeFetch(json(404, { error: { code: "endpoint_disabled", message: "Панель выключена" } })).fetch));
    await store.getState().restore();
    expect(store.getState().view).toMatchObject({ status: "blocked", error: { kind: "disabled" } });
  });

  it("вход разработчика: отказ остаётся на форме с текстом сервера", async () => {
    const { fetch, calls } = fakeFetch(
      json(403, { error: { code: "panel_forbidden", message: "В панель пускают только с ролью" } }),
      json(200, { data: IDENTITY }),
    );
    const store = createSessionStore(new AdminApi(fetch));

    await store.getState().loginDev("  dev-9:Гость ");
    expect(store.getState().view).toMatchObject({ status: "anonymous", loginError: { message: "В панель пускают только с ролью" } });
    expect(calls[0]?.init.body).toBe(JSON.stringify({ devUser: "dev-9:Гость" }));

    await store.getState().loginDev("dev-1:Владелец");
    expect(store.getState().view.status).toBe("ready");
  });

  it("401 посреди работы возвращает ко входу с объяснением", async () => {
    const api = new AdminApi(fakeFetch(json(200, { data: IDENTITY }), json(401, { error: { code: "unauthorized", message: "Сессия истекла" } })).fetch);
    const store = createSessionStore(api);
    await store.getState().restore();

    await api.request("/players", { schema: z.unknown() });
    expect(store.getState().view).toMatchObject({ status: "anonymous", notice: "Сессия истекла — войдите снова" });
  });

  it("выход закрывает панель на устройстве даже без ответа сервера", async () => {
    const store = createSessionStore(new AdminApi(fakeFetch(json(200, { data: IDENTITY }), new TypeError("fetch failed")).fetch));
    await store.getState().restore();
    await store.getState().logout();
    expect(store.getState().view.status).toBe("anonymous");
  });

  it("права читаются только у вошедшего", async () => {
    const store = createSessionStore(new AdminApi(fakeFetch(json(200, { data: IDENTITY })).fetch));
    expect(can(store.getState().view, "players.view")).toBe(false);
    await store.getState().restore();
    expect(can(store.getState().view, "players.view")).toBe(true);
    expect(can(store.getState().view, "roles.assign")).toBe(false);
  });
});

describe("вход через бота", () => {
  const OPENED = { requestId: "AbCdEfGhIjKlMnOpQrStUv", secret: "секрет-вкладки", code: "4821", link: "https://t.me/rubezh_bot?start=panel-AbCdEfGhIjKlMnOpQrStUv", expiresAt: "2026-09-29T12:05:00.000Z" };
  const START = Date.parse("2026-09-29T12:00:00.000Z");

  /** Часы, которые идут только по шагам опроса: каждое ожидание — плюс две секунды. */
  function timing() {
    let now = START;
    return { pollMs: 2_000, now: () => now, wait: async (ms: number) => void (now += ms) };
  }

  async function anonymousStore(...responses: (Response | Error)[]) {
    const { fetch, calls } = fakeFetch(json(401, { error: { code: "unauthorized", message: "нет" } }), ...responses);
    const store = createSessionStore(new AdminApi(fetch), timing());
    await store.getState().restore();
    return { store, calls };
  }

  it("код и ссылка, опрос до подтверждения — и панель открыта", async () => {
    const { store, calls } = await anonymousStore(
      json(201, { data: OPENED }),
      json(201, { data: { status: "pending" } }),
      json(201, { data: { status: "confirmed", identity: IDENTITY } }),
    );
    const login = store.getState().loginBot();
    await login;
    expect(store.getState().view).toEqual({ status: "ready", identity: IDENTITY });
    expect(calls.map((call) => call.url)).toEqual(["/api/v1/admin/session", "/api/v1/admin/session/bot", "/api/v1/admin/session/bot/poll", "/api/v1/admin/session/bot/poll"]);
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ requestId: OPENED.requestId, secret: OPENED.secret });
  });

  it("отказ в боте — на форме причина словами", async () => {
    const { store } = await anonymousStore(json(201, { data: OPENED }), json(201, { data: { status: "declined", reason: "no_role" } }));
    await store.getState().loginBot();
    expect(store.getState().view).toMatchObject({ status: "anonymous", bot: { status: "failed", message: expect.stringContaining("нет роли") } });
  });

  it("моргнувшая сеть не обрывает ожидание, а истёкший запрос — обрывает", async () => {
    const { store } = await anonymousStore(
      json(201, { data: OPENED }),
      new TypeError("fetch failed"),
      json(201, { data: { status: "expired" } }),
    );
    await store.getState().loginBot();
    expect(store.getState().view).toMatchObject({ bot: { status: "failed", message: expect.stringContaining("истёк") } });
  });

  it("срок вышел — дальше не спрашиваем", async () => {
    const pendingForever = Array.from({ length: 200 }, () => json(201, { data: { status: "pending" } }));
    const { store, calls } = await anonymousStore(json(201, { data: OPENED }), ...pendingForever);
    await store.getState().loginBot();
    expect(store.getState().view).toMatchObject({ bot: { status: "failed", message: expect.stringContaining("Время вышло") } });
    // Пять минут по две секунды — не больше полутораста опросов.
    expect(calls.length).toBeLessThanOrEqual(2 + 150);
  });

  it("отмена гасит опрос и возвращает кнопку", async () => {
    const { fetch } = fakeFetch(json(401, { error: { code: "unauthorized", message: "нет" } }), json(201, { data: OPENED }), json(201, { data: { status: "pending" } }));
    let release: () => void = () => undefined;
    const store = createSessionStore(new AdminApi(fetch), { pollMs: 2_000, now: () => START, wait: () => new Promise((resolve) => (release = resolve)) });
    await store.getState().restore();
    const login = store.getState().loginBot();
    await expect.poll(() => store.getState().view).toMatchObject({ bot: { status: "waiting", code: "4821", link: OPENED.link } });
    store.getState().cancelBot();
    release();
    await login;
    expect(store.getState().view).toMatchObject({ status: "anonymous", bot: { status: "idle" } });
  });
});
