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
  const ID = "AbCdEfGhIjKlMnOpQrStUv";
  const OPENED = {
    requestId: ID,
    secret: "секрет-вкладки",
    code: "4821",
    link: `https://t.me/rubezh_bot?start=panel-${ID}`,
    deepLink: `tg://resolve?domain=rubezh_bot&start=panel-${ID}`,
    expiresAt: "2026-09-29T12:05:00.000Z",
  };
  const START = Date.parse("2026-09-29T12:00:00.000Z");
  const EXPIRED = () => json(201, { data: { status: "expired" } });
  const PENDING = () => json(201, { data: { status: "pending" } });

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

  /** Сколько запросов входа открыто: `POST /session/bot`, а не опросы. */
  const opens = (calls: { url: string }[]) => calls.filter((call) => call.url.endsWith("/session/bot")).length;

  it("страница открывает запрос сама: код, обе ссылки, опрос до подтверждения — и панель открыта", async () => {
    const { store, calls } = await anonymousStore(json(201, { data: OPENED }), PENDING(), json(201, { data: { status: "confirmed", identity: IDENTITY } }));
    await store.getState().startBotLogin();
    expect(store.getState().view).toEqual({ status: "ready", identity: IDENTITY });
    expect(calls.map((call) => call.url)).toEqual(["/api/v1/admin/session", "/api/v1/admin/session/bot", "/api/v1/admin/session/bot/poll", "/api/v1/admin/session/bot/poll"]);
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ requestId: OPENED.requestId, secret: OPENED.secret });
  });

  it("ожидание хранит код, ссылку, диплинк и число замен", async () => {
    const { fetch } = fakeFetch(json(401, { error: { code: "unauthorized", message: "нет" } }), json(201, { data: OPENED }), PENDING());
    let release: () => void = () => undefined;
    const store = createSessionStore(new AdminApi(fetch), { pollMs: 2_000, now: () => START, wait: () => new Promise((resolve) => (release = resolve)) });
    await store.getState().restore();
    const login = store.getState().startBotLogin();
    await expect.poll(() => store.getState().view).toMatchObject({
      bot: { status: "waiting", code: "4821", link: OPENED.link, deepLink: OPENED.deepLink, renewals: 0 },
    });
    store.getState().cancelBot();
    release();
    await login;
    expect(store.getState().view).toMatchObject({ status: "anonymous", bot: { status: "idle" } });
  });

  it("повторный вызов за тот же показ страницы запрос не открывает", async () => {
    const { fetch, calls } = fakeFetch(json(401, { error: { code: "unauthorized", message: "нет" } }), json(201, { data: OPENED }), PENDING());
    let release: () => void = () => undefined;
    const store = createSessionStore(new AdminApi(fetch), { pollMs: 2_000, now: () => START, wait: () => new Promise((resolve) => (release = resolve)) });
    await store.getState().restore();
    const first = store.getState().startBotLogin();
    await expect.poll(() => store.getState().view).toMatchObject({ bot: { status: "waiting" } });
    await store.getState().startBotLogin();
    expect(opens(calls)).toBe(1);
    store.getState().cancelBot();
    release();
    await first;
  });

  it("не анонимному вход не открывается", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: IDENTITY }));
    const store = createSessionStore(new AdminApi(fetch), timing());
    await store.getState().restore();
    await store.getState().startBotLogin();
    expect(opens(calls)).toBe(0);
  });

  it("сервер без диплинка — ожидание с `deepLink: null`", async () => {
    const old: Record<string, unknown> = { ...OPENED };
    delete old.deepLink;
    const { store } = await anonymousStore(json(201, { data: old }), json(201, { data: { status: "confirmed", identity: IDENTITY } }));
    const seen: unknown[] = [];
    store.subscribe((state) => state.view.status === "anonymous" && state.view.bot.status === "waiting" && seen.push(state.view.bot.deepLink));
    await store.getState().startBotLogin();
    expect(seen).toContain(null);
  });

  it("отказ в боте — на форме причина словами, нового запроса сам не открывается", async () => {
    const { store, calls } = await anonymousStore(json(201, { data: OPENED }), json(201, { data: { status: "declined", reason: "no_role" } }));
    await store.getState().startBotLogin();
    expect(store.getState().view).toMatchObject({ status: "anonymous", bot: { status: "failed", message: expect.stringContaining("нет роли") } });
    expect(opens(calls)).toBe(1);
  });

  it("моргнувшая сеть не обрывает ожидание", async () => {
    const { store } = await anonymousStore(json(201, { data: OPENED }), new TypeError("fetch failed"), json(201, { data: { status: "confirmed", identity: IDENTITY } }));
    await store.getState().startBotLogin();
    expect(store.getState().view.status).toBe("ready");
  });

  it("истёк запрос — открывается новый сам, число замен растёт", async () => {
    const { store, calls } = await anonymousStore(
      json(201, { data: OPENED }),
      EXPIRED(),
      json(201, { data: { ...OPENED, code: "7777" } }),
      EXPIRED(),
      json(201, { data: { ...OPENED, code: "1234" } }),
      json(201, { data: { status: "confirmed", identity: IDENTITY } }),
    );
    const seen: string[] = [];
    store.subscribe((state) => {
      const bot = state.view.status === "anonymous" ? state.view.bot : null;
      if (bot?.status === "waiting") seen.push(`${bot.code}:${String(bot.renewals)}`);
    });
    await store.getState().startBotLogin();
    expect([...new Set(seen)]).toEqual(["4821:0", "7777:1", "1234:2"]);
    expect(opens(calls)).toBe(3);
    expect(store.getState().view.status).toBe("ready");
  });

  it("шестое истечение подряд — «Время вышло» без нового запроса", async () => {
    const six = Array.from({ length: 6 }, () => [json(201, { data: OPENED }), EXPIRED()]).flat();
    const { store, calls } = await anonymousStore(...six);
    await store.getState().startBotLogin();
    expect(store.getState().view).toMatchObject({ status: "anonymous", bot: { status: "failed", message: expect.stringContaining("Время вышло") } });
    expect(opens(calls)).toBe(6);
  });

  it("«Начать заново» после отказа открывает новый запрос, счёт замен — с нуля", async () => {
    const six = Array.from({ length: 6 }, () => [json(201, { data: OPENED }), EXPIRED()]).flat();
    const { store, calls } = await anonymousStore(...six, json(201, { data: { ...OPENED, code: "9999" } }), EXPIRED(), json(201, { data: { ...OPENED, code: "5555" } }), json(201, { data: { status: "confirmed", identity: IDENTITY } }));
    await store.getState().startBotLogin();
    expect(store.getState().view).toMatchObject({ bot: { status: "failed" } });
    const seen: string[] = [];
    store.subscribe((state) => {
      const bot = state.view.status === "anonymous" ? state.view.bot : null;
      if (bot?.status === "waiting") seen.push(`${bot.code}:${String(bot.renewals)}`);
    });
    await store.getState().loginBot();
    expect([...new Set(seen)]).toEqual(["9999:0", "5555:1"]);
    expect(opens(calls)).toBe(8);
  });

  it("запрос не открылся — на форме причина и «Начать заново»", async () => {
    const { store } = await anonymousStore(json(429, { error: { code: "rate_limited", message: "Слишком часто — подождите минуту" } }));
    await store.getState().startBotLogin();
    expect(store.getState().view).toMatchObject({ bot: { status: "failed", message: "Слишком часто — подождите минуту" } });
  });

  it("отмена гасит опрос и возвращает покой", async () => {
    const { fetch } = fakeFetch(json(401, { error: { code: "unauthorized", message: "нет" } }), json(201, { data: OPENED }), PENDING());
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
