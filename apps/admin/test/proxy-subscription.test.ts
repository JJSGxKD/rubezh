import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import {
  createSubscription,
  deleteSubscription,
  fetchSubscriptions,
  probeSubscription,
  refreshSubscription,
  updateSubscription,
  type SubscriptionForm,
  type SubscriptionInfo,
  type SubscriptionNode,
  type SubscriptionOverview,
} from "../src/api/proxy-subscription";
import { formatTime } from "../src/format";
import {
  canAddSubscription,
  countriesProblem,
  limitLine,
  nodeRows,
  nodesSummary,
  nodesToggleLabel,
  normalizeSubscriptionUrl,
  refreshLine,
  slotLine,
  subscriptionUrlProblem,
  trafficLine,
} from "../src/screens/proxies/subscription-view";
import { HELP } from "../src/ui/help";
import { fakeFetch, json } from "./helpers";

// Подписки Xray в панели (docs/35-stage4-plan.md Р101, Р192, tasks/T-0093,
// tasks/T-0384): адрес проверяется до отправки тем же правилом, что на сервере,
// и не возвращается назад; узлы рабочие сверху; трафик и срок читаются словами;
// подписок несколько, у каждой свои узлы и свои кнопки.

const GB = 1024 ** 3;

const SUBSCRIPTION: SubscriptionInfo = {
  key: "main",
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
  nodes: [],
};

const node = (patch: Partial<SubscriptionNode>): SubscriptionNode => ({ nodeKey: "aaaa", name: "Узел", protocol: "vless", country: "DE", host: "n.example.org", state: "unknown", latencyMs: null, ...patch });

const OVERVIEW: SubscriptionOverview = {
  encryption: true,
  sidecar: { connected: true },
  limit: 10,
  slotCount: 100,
  slotQuota: 50,
  subscriptions: [
    { ...SUBSCRIPTION, nodes: [node({})] },
    { ...SUBSCRIPTION, key: "a1b2c3d4e5f6", name: "Резервная", enabled: false, nodes: [] },
  ],
};

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

describe("сводка по узлам подписки", () => {
  const many = (healthy: number, down: number, unknown: number): SubscriptionNode[] => [
    ...Array.from({ length: healthy }, (_, index) => node({ nodeKey: `h${String(index)}`, state: "healthy", latencyMs: 40 })),
    ...Array.from({ length: down }, (_, index) => node({ nodeKey: `d${String(index)}`, state: "down" })),
    ...Array.from({ length: unknown }, (_, index) => node({ nodeKey: `u${String(index)}`, state: "unknown" })),
  ];

  it("общее число и разбивка по состояниям: «37 узлов: работают 30, не отвечают 5, не проверены 2»", () => {
    expect(nodesSummary(many(30, 5, 2))).toBe("37 узлов: работают 30, не отвечают 5, не проверены 2");
  });

  it("состояния без узлов в сводку не попадают", () => {
    expect(nodesSummary(many(5, 0, 0))).toBe("5 узлов: работают 5");
    expect(nodesSummary(many(0, 3, 0))).toBe("3 узла: не отвечают 3");
    expect(nodesSummary(many(0, 0, 4))).toBe("4 узла: не проверены 4");
  });

  it("склонение по числу: один узел, два узла, пять узлов, двадцать один узел, одиннадцать узлов", () => {
    expect(nodesSummary(many(1, 0, 0))).toBe("1 узел: работает 1");
    expect(nodesSummary(many(0, 0, 1))).toBe("1 узел: не проверен 1");
    expect(nodesSummary(many(0, 1, 1))).toBe("2 узла: не отвечает 1, не проверен 1");
    expect(nodesSummary(many(21, 0, 0))).toBe("21 узел: работает 21");
    expect(nodesSummary(many(11, 0, 0))).toBe("11 узлов: работают 11");
    expect(nodesSummary(many(22, 0, 0))).toBe("22 узла: работают 22");
  });

  it("узлов нет — так и сказано", () => {
    expect(nodesSummary([])).toBe("Узлов пока нет");
  });

  it("строка про входы: сколько всего и сколько на подписку", () => {
    expect(slotLine({ slotCount: 100, slotQuota: 50 })).toBe("Входов Xray: 100, на подписку — 50");
    expect(slotLine({ slotCount: 100, slotQuota: 100 })).toBe("Входов Xray: 100, на подписку — 100");
    expect(slotLine({ slotCount: 4, slotQuota: 0 })).toBe("Входов Xray: 4, на подписку — 0");
  });

  it("кнопка узлов: «Показать узлы (37)» и «Скрыть узлы»", () => {
    expect(nodesToggleLabel(37, false)).toBe("Показать узлы (37)");
    expect(nodesToggleLabel(37, true)).toBe("Скрыть узлы");
    expect(nodesToggleLabel(0, false)).toBe("Показать узлы (0)");
  });

  it("добавить можно, пока подписок меньше предела; на пределе — строка с причиной", () => {
    expect(canAddSubscription({ ...OVERVIEW, subscriptions: [] })).toBe(true);
    expect(canAddSubscription(OVERVIEW)).toBe(true);
    const full: SubscriptionOverview = { ...OVERVIEW, subscriptions: Array.from({ length: 10 }, (_, index) => ({ ...SUBSCRIPTION, key: `s${String(index)}` })) };
    expect(canAddSubscription(full)).toBe(false);
    expect(limitLine(full)).toBe("Подписок 10 — больше добавить нельзя: удалите лишнюю");
    expect(limitLine(OVERVIEW)).toBeNull();
  });
});

describe("запросы к серверу", () => {
  it("просмотр: ответ с несколькими подписками разбирается; адрес, даже если сервер вдруг прислал, в данные не попадает", async () => {
    const leaky = { ...OVERVIEW, subscriptions: OVERVIEW.subscriptions.map((entry) => ({ ...entry, url: "https://утечка", urlCt: "утечка" })) };
    const { fetch, calls } = fakeFetch(json(200, { data: leaky }));
    const result = await fetchSubscriptions(new AdminApi(fetch));

    expect(calls[0]?.url).toBe("/api/v1/admin/proxy-subscriptions");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual(OVERVIEW);
    expect(result.data.subscriptions.map((entry) => entry.key)).toEqual(["main", "a1b2c3d4e5f6"]);
    expect(JSON.stringify(result.data)).not.toContain("утечка");
  });

  it("пусто: подписок нет, контейнера нет", async () => {
    const { fetch } = fakeFetch(json(200, { data: { encryption: false, sidecar: { connected: false }, limit: 10, slotCount: 100, slotQuota: 100, subscriptions: [] } }));
    const result = await fetchSubscriptions(new AdminApi(fetch));
    expect(result.ok && result.data.subscriptions).toEqual([]);
    expect(result.ok && result.data.sidecar.connected).toBe(false);
    expect(result.ok && result.data.limit).toBe(10);
  });

  it("ответ не по схеме — честная ошибка: неизвестное состояние узла, нет ключа подписки, нет предела", async () => {
    const broken = [
      { ...OVERVIEW, subscriptions: [{ ...SUBSCRIPTION, nodes: [{ ...node({}), state: "broken" }] }] },
      { ...OVERVIEW, subscriptions: [{ ...SUBSCRIPTION, key: undefined }] },
      { ...OVERVIEW, limit: undefined },
      { ...OVERVIEW, subscription: null, subscriptions: undefined },
    ];
    for (const data of broken) {
      const { fetch } = fakeFetch(json(200, { data }));
      expect((await fetchSubscriptions(new AdminApi(fetch))).ok).toBe(false);
    }
  });

  it("создание: POST на корень, строки обрезаны, страны заглавными списком без пустых, адрес без пробелов по краям", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: OVERVIEW }));
    await createSubscription(new AdminApi(fetch), FORM);

    expect(calls[0]?.url).toBe("/api/v1/admin/proxy-subscriptions");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ name: "Основная", url: "https://sub.example.com/s/abc", countries: ["DE", "NL"], enabled: true });
  });

  it("правка: PUT на ключ подписки; пустой адрес — поля url в теле нет, сервер оставит прежний", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: OVERVIEW }), json(200, { data: OVERVIEW }));
    const api = new AdminApi(fetch);
    await updateSubscription(api, "a1b2c3d4e5f6", { ...FORM, url: "   ", countries: "" });
    await updateSubscription(api, "main", FORM);

    expect(calls[0]?.url).toBe("/api/v1/admin/proxy-subscriptions/a1b2c3d4e5f6");
    expect(calls[0]?.init.method).toBe("PUT");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect("url" in body).toBe(false);
    expect(body.countries).toEqual([]);
    expect(calls[1]?.url).toBe("/api/v1/admin/proxy-subscriptions/main");
    expect(JSON.parse(String(calls[1]?.init.body))).toMatchObject({ url: "https://sub.example.com/s/abc" });
  });

  it("обновить, проверить узлы, удалить — свои адреса и методы, у каждой подписки свои", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: OVERVIEW }), json(200, { data: OVERVIEW }), json(200, { data: { removed: true } }), json(200, { data: OVERVIEW }));
    const api = new AdminApi(fetch);
    await refreshSubscription(api, "main");
    await probeSubscription(api, "a1b2c3d4e5f6");
    const removed = await deleteSubscription(api, "main");
    await refreshSubscription(api, "a1b2c3d4e5f6");

    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ["POST", "/api/v1/admin/proxy-subscriptions/main/refresh"],
      ["POST", "/api/v1/admin/proxy-subscriptions/a1b2c3d4e5f6/probe"],
      ["DELETE", "/api/v1/admin/proxy-subscriptions/main"],
      ["POST", "/api/v1/admin/proxy-subscriptions/a1b2c3d4e5f6/refresh"],
    ]);
    expect(removed.ok).toBe(true);
  });

  it("слишком частое нажатие: ошибка сервера доходит текстом", async () => {
    const { fetch } = fakeFetch(json(429, { error: { code: "rate_limited", message: "Подождите минуту" } }));
    const result = await refreshSubscription(new AdminApi(fetch), "main");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("Подождите минуту");
  });

  it("11-я подписка и занятый замок: тексты сервера доходят как есть", async () => {
    const { fetch } = fakeFetch(
      json(409, { error: { code: "proxy_subscription_limit", message: "Подписок уже 10 — удалите лишнюю, чтобы добавить новую" } }),
      json(409, { error: { code: "proxy_subscription_busy", message: "Подписки сейчас обновляются на сервере — повторите через минуту" } }),
    );
    const api = new AdminApi(fetch);
    const limit = await createSubscription(api, FORM);
    const busy = await deleteSubscription(api, "main");

    expect(!limit.ok && limit.error.message).toBe("Подписок уже 10 — удалите лишнюю, чтобы добавить новую");
    expect(!busy.ok && busy.error.message).toBe("Подписки сейчас обновляются на сервере — повторите через минуту");
  });
});

describe("пояснение раздела", () => {
  it("подсказка про подписки: до десяти, общий запас, доли входов, секретный адрес", () => {
    const text = HELP.proxies.subscription;
    expect(text).toContain("до десяти");
    expect(text).toContain("общий запас");
    expect(text).toMatch(/поровну/);
    expect(text).toContain("Адрес подписки");
    expect(text).toMatch(/не показывается|назад не/);
  });
});
