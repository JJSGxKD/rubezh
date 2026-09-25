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
