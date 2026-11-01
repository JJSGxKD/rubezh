import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import {
  PROXY_MODES,
  checkProxy,
  checkSummary,
  createProxy,
  fetchModes,
  fetchProxies,
  modeLabel,
  proxyHostProblem,
  proxyProblem,
  serviceTitle,
  setServiceMode,
  updateProxy,
  type ProxyForm,
  type ProxyRow,
} from "../src/api/proxies";
import { SECTION_GROUPS, SECTIONS } from "../src/routes";
import { HELP } from "../src/ui/help";
import { fakeFetch, json } from "./helpers";

// Прокси в панели (docs/35-stage4-plan.md Р91, tasks/T-0065): разбор списка и
// режимов, вид хоста проверяется до отправки тем же правилом, что на сервере,
// пароль уходит только когда его ввели, а раздел стоит в «Эксплуатации».

const ROW: ProxyRow = {
  proxyId: "9b0f4f0e-5c1e-4a43-9a52-0d8f6a7c1111",
  name: "Фермерский",
  scheme: "socks5",
  host: "tunnel",
  port: 1080,
  username: "farmer",
  passwordSet: true,
  passwordUnreadable: false,
  country: "NL",
  enabled: true,
  priority: 10,
  note: "туннель в Нидерланды",
  lastCheck: { at: "2026-10-29T12:00:00.000Z", ok: true, note: "Внешний адрес 203.0.113.7 · 230 мс" },
  updatedBy: "00000000-0000-4000-8000-000000000001",
  updatedAt: "2026-10-29T11:00:00.000Z",
};

const FORM: ProxyForm = {
  name: "  Фермерский ",
  scheme: "http",
  host: " Proxy.Example.com ",
  port: "3128",
  username: "",
  password: "",
  country: "de",
  enabled: true,
  note: "",
};

describe("список прокси", () => {
  it("разбирается; пароль, даже если сервер вдруг его прислал, в данные не попадает", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { enabled: true, proxies: [{ ...ROW, password: "утечка", passwordCt: "утечка" }] } }));
    const result = await fetchProxies(new AdminApi(fetch));

    expect(calls[0]?.url).toBe("/api/v1/admin/proxies");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.enabled).toBe(true);
    expect(result.data.proxies[0]).toEqual(ROW);
    expect(JSON.stringify(result.data)).not.toContain("утечка");
  });

  it("ответ не по схеме — честная ошибка, а не таблица с undefined", async () => {
    const { fetch } = fakeFetch(json(200, { data: { enabled: true, proxies: [{ ...ROW, port: "1080" }] } }));
    const result = await fetchProxies(new AdminApi(fetch));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unavailable");
  });

  it("схема вне перечня — тоже отказ: панель не знает, как её показать", async () => {
    const { fetch } = fakeFetch(json(200, { data: { enabled: true, proxies: [{ ...ROW, scheme: "ftp" }] } }));
    expect((await fetchProxies(new AdminApi(fetch))).ok).toBe(false);
  });
});

describe("запись прокси", () => {
  it("создание: строки обрезаны, страна заглавными, порт числом, пустые логин и заметка — null, пустого пароля в теле нет", async () => {
    const { fetch, calls } = fakeFetch(json(201, { data: ROW }));
    await createProxy(new AdminApi(fetch), FORM);

    expect(calls[0]?.url).toBe("/api/v1/admin/proxies");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ name: "Фермерский", scheme: "http", host: "Proxy.Example.com", port: 3128, username: null, country: "DE", enabled: true, note: null });
  });

  it("создание с логином и паролем: пароль уходит как введён, без обрезки пробелов", async () => {
    const { fetch, calls } = fakeFetch(json(201, { data: ROW }));
    await createProxy(new AdminApi(fetch), { ...FORM, username: " farmer ", password: " с пробелами " });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ username: "farmer", password: " с пробелами " });
  });

  it("правка: пустое поле пароля — пароль не уходит вовсе (сервер оставит прежний)", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: ROW }));
    await updateProxy(new AdminApi(fetch), ROW.proxyId, { ...FORM, username: "farmer" });

    expect(calls[0]?.url).toBe(`/api/v1/admin/proxies/${ROW.proxyId}`);
    expect(calls[0]?.init.method).toBe("PATCH");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect("password" in body).toBe(false);
    expect("clearPassword" in body).toBe(false);
  });

  it("правка: новый пароль заменяет; «Удалить пароль» — явный флаг и без пароля", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: ROW }), json(200, { data: ROW }));
    const api = new AdminApi(fetch);
    await updateProxy(api, ROW.proxyId, { ...FORM, username: "farmer", password: "новый" });
    await updateProxy(api, ROW.proxyId, { ...FORM, username: "farmer", password: "не уйдёт", clearPassword: true });

    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ password: "новый" });
    const cleared = JSON.parse(String(calls[1]?.init.body)) as Record<string, unknown>;
    expect(cleared.clearPassword).toBe(true);
    expect("password" in cleared).toBe(false);
  });

  it("правка: очищенные логин и заметка уходят как null — иначе их не убрать", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: ROW }));
    await updateProxy(new AdminApi(fetch), ROW.proxyId, { ...FORM, username: "", note: "  " });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ username: null, note: null });
  });
});

describe("проверка прокси", () => {
  it("POST на :id/check, ответ с обновлённой строкой разбирается", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { ok: true, message: "Внешний адрес 203.0.113.7 · 230 мс", proxy: ROW } }));
    const result = await checkProxy(new AdminApi(fetch), ROW.proxyId);

    expect(calls[0]?.url).toBe(`/api/v1/admin/proxies/${ROW.proxyId}/check`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(result.ok && result.data.ok).toBe(true);
    expect(result.ok && result.data.proxy.lastCheck?.note).toContain("203.0.113.7");
  });

  it("итог проверки словами: не проверялась, прошла, не прошла, пароль не читается", () => {
    expect(checkSummary({ ...ROW, lastCheck: null })).toMatchObject({ tone: "neutral", label: "Не проверялся" });
    expect(checkSummary(ROW)).toMatchObject({ tone: "success", label: "Работает" });
    expect(checkSummary(ROW).detail).toContain("203.0.113.7");
    expect(checkSummary({ ...ROW, lastCheck: { at: ROW.updatedAt, ok: false, note: "Нет ответа за 5 с" } })).toMatchObject({ tone: "danger", label: "Не отвечает" });
    expect(checkSummary({ ...ROW, passwordUnreadable: true })).toMatchObject({ tone: "danger", label: "Пароль не читается" });
  });
});

describe("режимы сервисов", () => {
  const MODES = {
    data: {
      modes: [
        { service: "fx.cbr", mode: "direct_first", default: "direct_first", custom: false, updatedAt: null },
        { service: "telegram.bot", mode: "direct_only", default: "direct_only", custom: false, updatedAt: null },
        { service: "ads.postback", mode: "proxy_only", default: "direct_first", custom: true, updatedAt: "2026-10-29T10:00:00.000Z" },
      ],
    },
  };

  it("список разбирается; режим вне перечня — отказ", async () => {
    const { fetch, calls } = fakeFetch(json(200, MODES), json(200, { data: { modes: [{ ...MODES.data.modes[0], mode: "всегда" }] } }));
    const api = new AdminApi(fetch);
    const result = await fetchModes(api);
    expect(calls[0]?.url).toBe("/api/v1/admin/proxies/modes");
    expect(result.ok && result.data.modes.map((mode) => mode.service)).toEqual(["fx.cbr", "telegram.bot", "ads.postback"]);
    expect((await fetchModes(api)).ok).toBe(false);
  });

  it("смена режима: PUT на modes/<сервис> с одним полем mode", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: MODES.data.modes[2] }));
    const result = await setServiceMode(new AdminApi(fetch), "ads.postback", "proxy_only");

    expect(calls[0]?.url).toBe("/api/v1/admin/proxies/modes/ads.postback");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ mode: "proxy_only" });
    expect(result.ok && result.data.custom).toBe(true);
  });

  it("три режима, у каждого своя подпись; сервис без названия показывается как есть", () => {
    expect([...PROXY_MODES]).toEqual(["direct_first", "proxy_only", "direct_only"]);
    expect(PROXY_MODES.map(modeLabel)).toEqual(["Сначала напрямую", "Только через прокси", "Только напрямую"]);
    expect(serviceTitle("telegram.bot")).toBe("Bot API Telegram");
    expect(serviceTitle("unknown.service")).toBe("unknown.service");
  });
});

describe("проверка формы до отправки", () => {
  it.each(["proxy.example.com", "10.0.0.5", "tunnel", "my_tunnel.internal", "2001:db8::1", "EXAMPLE.com"])("хост «%s» годится", (host) => {
    expect(proxyHostProblem(host)).toBeNull();
  });

  it.each([
    ["", "Укажите адрес"],
    ["http://proxy.example.com", "без схемы"],
    ["socks5://tunnel", "без схемы"],
    ["proxy.example.com:3128", "порт — в отдельном поле"],
    ["proxy.example.com/path", "без пути"],
    ["bad host", "без пробелов"],
    ["a".repeat(256), "не длиннее 255"],
  ])("хост «%s» отклонён: %s", (host, part) => {
    expect(proxyHostProblem(host)).toContain(part);
  });

  it("форма целиком: первая найденная причина словами, годная форма — null", () => {
    expect(proxyProblem(FORM)).toBeNull();
    expect(proxyProblem({ ...FORM, name: "  " })).toMatch(/название/i);
    expect(proxyProblem({ ...FORM, name: "я".repeat(61) })).toMatch(/60/);
    expect(proxyProblem({ ...FORM, host: "http://x" })).toMatch(/схем/i);
    expect(proxyProblem({ ...FORM, port: "0" })).toMatch(/порт/i);
    expect(proxyProblem({ ...FORM, port: "65536" })).toMatch(/порт/i);
    expect(proxyProblem({ ...FORM, port: "80.5" })).toMatch(/порт/i);
    expect(proxyProblem({ ...FORM, port: "" })).toMatch(/порт/i);
    expect(proxyProblem({ ...FORM, country: "D" })).toMatch(/страна/i);
    expect(proxyProblem({ ...FORM, country: "D1" })).toMatch(/страна/i);
    expect(proxyProblem({ ...FORM, country: "ru" })).toBeNull();
    expect(proxyProblem({ ...FORM, note: "я".repeat(201) })).toMatch(/200/);
  });

  it("пароль без логина не бывает; при правке уже заданный пароль без логина — тоже", () => {
    expect(proxyProblem({ ...FORM, password: "секрет" })).toMatch(/логин/i);
    expect(proxyProblem({ ...FORM, username: "u", password: "секрет" })).toBeNull();
    expect(proxyProblem({ ...FORM, username: "" }, { passwordSet: true })).toMatch(/логин/i);
    expect(proxyProblem({ ...FORM, username: "", clearPassword: true }, { passwordSet: true })).toBeNull();
  });
});

describe("раздел «Прокси»", () => {
  it("стоит в группе «Эксплуатация» под правом proxies.view со своим значком и подсказкой", () => {
    const section = SECTIONS.find((item) => item.id === "proxies");
    expect(section).toMatchObject({ title: "Прокси", permission: "proxies.view", hint: "Через что сервер ходит к внешним API, если напрямую не достучаться" });
    expect(section?.icon).toBeDefined();
    const group = SECTION_GROUPS.find((item) => item.sections.some((candidate) => candidate.id === "proxies"));
    expect(group?.title).toBe("Эксплуатация");
  });

  it("пояснение про режимы названо в словаре", () => {
    expect(HELP.proxies.modes).toContain("Сначала напрямую");
    expect(HELP.proxies.modes).toContain("Только через прокси");
  });
});
