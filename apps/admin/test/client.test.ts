import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AdminApi, CSRF_HEADER, CSRF_VALUE, kindOf, urlOf } from "../src/api/client";
import { fakeFetch, json } from "./helpers";

const schema = z.object({ value: z.number() });

describe("клиент API панели", () => {
  it("читает конверт { data } и ходит только на свой домен с cookie", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { value: 7 } }));
    const result = await new AdminApi(fetch).request("/players", { query: { query: "ann", limit: 20, empty: "", none: undefined }, schema });

    expect(result).toEqual({ ok: true, data: { value: 7 } });
    expect(calls[0]?.url).toBe("/api/v1/admin/players?query=ann&limit=20");
    expect(calls[0]?.init.credentials).toBe("same-origin");
    // Чтение заголовка панели не несёт: он нужен только изменяющим запросам.
    expect(calls[0]?.init.headers).not.toHaveProperty(CSRF_HEADER);
  });

  it("изменяющий запрос несёт заголовок панели и JSON", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { value: 1 } }));
    await new AdminApi(fetch).request("/players/x/ban", { method: "POST", body: { reason: "читы" }, schema });

    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toMatchObject({ [CSRF_HEADER]: CSRF_VALUE, "content-type": "application/json" });
    expect(calls[0]?.init.body).toBe(JSON.stringify({ reason: "читы" }));
  });

  it("ответ не по схеме — честная ошибка, а не данные с дырами", async () => {
    const { fetch } = fakeFetch(json(200, { data: { value: "семь" } }));
    const result = await new AdminApi(fetch).request("/x", { schema });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unavailable");
  });

  it("берёт код и текст ошибки сервера, а без них — свой текст", async () => {
    const { fetch } = fakeFetch(json(403, { error: { code: "forbidden", message: "Нет права players.ban" } }), new Response("<html>502</html>", { status: 502 }));
    const api = new AdminApi(fetch);

    const denied = await api.request("/x", { schema });
    expect(denied).toEqual({ ok: false, error: { kind: "forbidden", status: 403, code: "forbidden", message: "Нет права players.ban" } });

    const proxy = await api.request("/x", { schema });
    expect(proxy.ok).toBe(false);
    if (!proxy.ok) expect(proxy.error).toMatchObject({ kind: "unavailable", status: 502, code: null });
  });

  it("401 зовёт слушателей: стор сессии возвращает панель ко входу", async () => {
    const { fetch } = fakeFetch(json(401, { error: { code: "unauthorized", message: "Сессии нет" } }));
    const api = new AdminApi(fetch);
    let heard = 0;
    api.onUnauthorized(() => heard++);

    const result = await api.request("/x", { schema });
    expect(result.ok).toBe(false);
    expect(heard).toBe(1);
  });

  it("сеть и таймаут — offline, с разным текстом", async () => {
    const timeout = new DOMException("истекло", "TimeoutError");
    const { fetch } = fakeFetch(new TypeError("fetch failed"), timeout);
    const api = new AdminApi(fetch);

    const network = await api.request("/x", { schema });
    const slow = await api.request("/x", { schema });
    expect(network.ok || network.error.kind).toBe("offline");
    expect(slow.ok || slow.error.message).toBe("API не ответил вовремя");
  });

  it("различает выключенную панель и отсутствующий объект по коду 404", () => {
    expect(kindOf(404, "endpoint_disabled")).toBe("disabled");
    expect(kindOf(404, "account_not_found")).toBe("not_found");
    expect(kindOf(429, "rate_limited")).toBe("rate_limited");
    expect(kindOf(400, "validation_failed")).toBe("rejected");
    expect(kindOf(503, "store_unavailable")).toBe("unavailable");
  });

  it("кодирует значения запроса", () => {
    expect(urlOf("/players", { query: "@ann & co" })).toBe("/api/v1/admin/players?query=%40ann+%26+co");
  });
});
