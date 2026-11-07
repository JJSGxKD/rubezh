import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import {
  deleteSubscription,
  fetchSubscription,
  probeSubscription,
  refreshSubscription,
  saveSubscription,
  type SubscriptionForm,
  type SubscriptionNode,
  type SubscriptionOverview,
} from "../src/api/proxy-subscription";
import { formatTime } from "../src/format";
import { countriesProblem, nodeRows, normalizeSubscriptionUrl, refreshLine, subscriptionUrlProblem, trafficLine } from "../src/screens/proxies/subscription-view";
import { HELP } from "../src/ui/help";
import { fakeFetch, json } from "./helpers";

// Подписка Xray в панели (docs/35-stage4-plan.md Р101, tasks/T-0093): адрес
// проверяется до отправки тем же правилом, что на сервере, и не возвращается
// назад; узлы рабочие сверху; трафик и срок читаются словами.

const GB = 1024 ** 3;

const SUBSCRIPTION: NonNullable<SubscriptionOverview["subscription"]> = {
  name: "Основная",
  urlHint: "sub.example.com …c3d4",
  enabled: true,
  countries: ["DE", "NL"],
  lastRefreshAt: "2026-11-02T09:40:00.000Z",
  lastRefreshOk: true,
  lastRefreshNote: "37 узлов, пропущено 3 (протокол: 2, транспорт: 1)",
  trafficUsedBytes: 380 * GB,
  trafficTotalBytes: 500 * GB,
  expiresAt: "2026-12-01T00:00:00.000Z",
  updatedAt: "2026-11-02T09:00:00.000Z",
};

const node = (patch: Partial<SubscriptionNode>): SubscriptionNode => ({ nodeKey: "aaaa", name: "Узел", protocol: "vless", country: "DE", host: "n.example.org", state: "unknown", latencyMs: null, ...patch });

const OVERVIEW: SubscriptionOverview = { encryption: true, sidecar: { connected: true }, subscription: SUBSCRIPTION, nodes: [node({})] };

const FORM: SubscriptionForm = { name: "  Основная ", url: " https://sub.example.com/s/abc ", countries: "de, nl  ,", enabled: true };

describe("адрес подписки до отправки", () => {
  it("каждая ошибка — своим текстом; публичный https годится", () => {
    expect(subscriptionUrlProblem("")).toBe("Укажите адрес подписки");
    expect(subscriptionUrlProblem("http://sub.example.com/s")).toBe("Нужен адрес https:// — http и другие схемы не подходят");
    expect(subscriptionUrlProblem("https://user:pass@sub.example.com/s")).toBe("Уберите логин и пароль из адреса: подписке они не нужны");
    expect(subscriptionUrlProblem("не адрес")).toBe("Не похоже на адрес подписки: скопируйте ссылку целиком");
    expect(subscriptionUrlProblem("https://10.0.0.5/s")).toBe("Это адрес локальной сети — нужен адрес поставщика в интернете");
    expect(subscriptionUrlProblem("https://redis/s")).toBe("Это адрес локальной сети — нужен адрес поставщика в интернете");
    expect(subscriptionUrlProblem("happ://crypt5/abcdef")).toBe("Зашифрованная ссылка Happ не подойдёт: нужен исходный адрес подписки https://");
    expect(subscriptionUrlProblem("  https://sub.example.com/s?token=abc ")).toBeNull();
    expect(subscriptionUrlProblem("https://sotto.libhub.link/3jk_M2xYz")).toBeNull();
  });

  it("ссылку без схемы и обёртку Happ принимает и отправляет как https", () => {
    expect(subscriptionUrlProblem("sotto.libhub.link/3jk_M2xYz")).toBeNull();
    expect(normalizeSubscriptionUrl(" sotto.libhub.link/3jk_M2xYz ")).toBe("https://sotto.libhub.link/3jk_M2xYz");
    expect(normalizeSubscriptionUrl("happ://add/https://sotto.libhub.link/3jk")).toBe("https://sotto.libhub.link/3jk");
    expect(normalizeSubscriptionUrl("https://sub.example.com/s")).toBe("https://sub.example.com/s");
    expect(normalizeSubscriptionUrl("")).toBe("");
  });

  it("при правке пустой адрес значит «оставить прежний»", () => {
    expect(subscriptionUrlProblem("", { keep: true })).toBeNull();
    expect(subscriptionUrlProblem("http://x.example.com", { keep: true })).toBe("Нужен адрес https:// — http и другие схемы не подходят");
  });
});

describe("страны узлов", () => {
  it("коды через запятую: пусто и верные — годятся; строчные, три буквы и больше десяти — нет", () => {
    expect(countriesProblem("")).toBeNull();
    expect(countriesProblem("DE, nl")).toBeNull();
    expect(countriesProblem("DEU")).toBe("Страны — коды из двух латинских букв через запятую, например DE, NL");
    expect(countriesProblem("D1")).not.toBeNull();
    expect(countriesProblem("AA, AB, AC, AD, AE, AF, AG, AH, AI, AJ, AK")).toBe("Стран — не больше десяти");
  });
});

describe("трафик и итог обновления", () => {
  it("трафик: сколько осталось из скольких и до какого числа", () => {
    expect(trafficLine(SUBSCRIPTION)).toBe("Осталось 120 ГБ из 500 ГБ · до 01.12.2026");
  });

  it("поставщик ничего не сообщил — строки нет; срока нет — строка без него; перерасход не уходит в минус", () => {
    expect(trafficLine({ ...SUBSCRIPTION, trafficUsedBytes: null, trafficTotalBytes: null, expiresAt: null })).toBeNull();
    expect(trafficLine({ ...SUBSCRIPTION, expiresAt: null })).toBe("Осталось 120 ГБ из 500 ГБ");
    expect(trafficLine({ ...SUBSCRIPTION, trafficUsedBytes: 600 * GB, expiresAt: null })).toBe("Осталось 0 ГБ из 500 ГБ");
    expect(trafficLine({ ...SUBSCRIPTION, trafficUsedBytes: null, trafficTotalBytes: null })).toBe("Подписка действует до 01.12.2026");
  });

  it("итог: удачный — «Обновлена время — заметка», неудачный красным, не обновлялась — подсказка", () => {
    expect(refreshLine(SUBSCRIPTION)).toEqual({ tone: "neutral", text: `Обновлена ${formatTime("2026-11-02T09:40:00.000Z")} — 37 узлов, пропущено 3 (протокол: 2, транспорт: 1)` });
    expect(refreshLine({ ...SUBSCRIPTION, lastRefreshOk: false, lastRefreshNote: "Подписка пустая" })).toEqual({ tone: "danger", text: "Подписка пустая" });
    expect(refreshLine({ ...SUBSCRIPTION, lastRefreshAt: null, lastRefreshOk: null, lastRefreshNote: null }).text).toContain("Ещё не обновлялась");
  });
});

describe("таблица узлов", () => {
  it("рабочие сверху (быстрые первыми), затем не проверенные, затем не отвечающие", () => {
    const rows = nodeRows([
      node({ nodeKey: "d", name: "Лежит", state: "down" }),
      node({ nodeKey: "n", name: "Новый", state: "unknown" }),
      node({ nodeKey: "s", name: "Медленный", state: "healthy", latencyMs: 210 }),
      node({ nodeKey: "f", name: "Быстрый", state: "healthy", latencyMs: 35 }),
    ]);

    expect(rows.map((row) => row.name)).toEqual(["Быстрый", "Медленный", "Новый", "Лежит"]);
    expect(rows.map((row) => row.statusLabel)).toEqual(["Работает", "Работает", "Не проверен", "Не отвечает"]);
    expect(rows.map((row) => row.latencyText)).toEqual(["35 мс", "210 мс", "—", "—"]);
    expect(rows.map((row) => row.tone)).toEqual(["success", "success", "neutral", "danger"]);
  });

  it("страна без значения — прочерк; порядок равных стабилен по названию", () => {
    const rows = nodeRows([node({ nodeKey: "b", name: "Б", country: null }), node({ nodeKey: "a", name: "А" })]);
    expect(rows.map((row) => row.name)).toEqual(["А", "Б"]);
    expect(rows[1]?.countryText).toBe("—");
  });
});

describe("запросы к серверу", () => {
  it("просмотр: ответ разбирается; адрес, даже если сервер вдруг прислал, в данные не попадает", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { ...OVERVIEW, subscription: { ...SUBSCRIPTION, url: "https://утечка", urlCt: "утечка" } } }));
    const result = await fetchSubscription(new AdminApi(fetch));

    expect(calls[0]?.url).toBe("/api/v1/admin/proxy-subscription");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual(OVERVIEW);
    expect(JSON.stringify(result.data)).not.toContain("утечка");
  });

  it("пусто: подписки нет, контейнера нет", async () => {
    const { fetch } = fakeFetch(json(200, { data: { encryption: false, sidecar: { connected: false }, subscription: null, nodes: [] } }));
    const result = await fetchSubscription(new AdminApi(fetch));
    expect(result.ok && result.data.subscription).toBeNull();
    expect(result.ok && result.data.sidecar.connected).toBe(false);
  });

  it("ответ не по схеме — честная ошибка", async () => {
    const { fetch } = fakeFetch(json(200, { data: { ...OVERVIEW, nodes: [{ ...node({}), state: "broken" }] } }));
    expect((await fetchSubscription(new AdminApi(fetch))).ok).toBe(false);
  });

  it("сохранение: строки обрезаны, страны заглавными списком без пустых, адрес уходит как введён без пробелов по краям", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: OVERVIEW }));
    await saveSubscription(new AdminApi(fetch), FORM);

    expect(calls[0]?.url).toBe("/api/v1/admin/proxy-subscription");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ name: "Основная", url: "https://sub.example.com/s/abc", countries: ["DE", "NL"], enabled: true });
  });

  it("правка с пустым адресом: поля url в теле нет — сервер оставит прежний", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: OVERVIEW }));
    await saveSubscription(new AdminApi(fetch), { ...FORM, url: "   ", countries: "" });

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect("url" in body).toBe(false);
    expect(body.countries).toEqual([]);
  });

  it("обновить, проверить узлы, удалить — свои адреса и методы", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: OVERVIEW }), json(200, { data: OVERVIEW }), json(200, { data: { removed: true } }));
    const api = new AdminApi(fetch);
    await refreshSubscription(api);
    await probeSubscription(api);
    const removed = await deleteSubscription(api);

    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ["POST", "/api/v1/admin/proxy-subscription/refresh"],
      ["POST", "/api/v1/admin/proxy-subscription/probe"],
      ["DELETE", "/api/v1/admin/proxy-subscription"],
    ]);
    expect(removed.ok).toBe(true);
  });

  it("слишком частое нажатие: ошибка сервера доходит текстом", async () => {
    const { fetch } = fakeFetch(json(429, { error: { code: "rate_limited", message: "Подождите минуту" } }));
    const result = await refreshSubscription(new AdminApi(fetch));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("Подождите минуту");
  });
});

describe("пояснение раздела", () => {
  it("подсказка про подписку есть и не обещает показывать адрес", () => {
    expect(HELP.proxies.subscription).toContain("Адрес подписки");
    expect(HELP.proxies.subscription).toMatch(/не показывается|назад не/);
  });
});
