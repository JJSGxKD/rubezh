import "reflect-metadata";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from "node:net";
import { Agent, ProxyAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Outbound, type OutboundRecord, type OutboundSink } from "../src/infra/outbound/outbound.js";
import {
  DIRECT_ATTEMPT_MS,
  PROXY_ATTEMPT_MS,
  ROUTE_MEMORY_SEC,
  OutboundNoRouteError,
  attemptPlan,
  defaultModeOf,
  shouldFallBack,
  type OutboundMode,
  type OutboundProxy,
  type OutboundRoutes,
  type ProxyFetch,
  type RouteMemory,
} from "../src/infra/outbound/outbound-route.js";
import { OUTBOUND_SERVICES } from "../src/infra/outbound/outbound-services.js";
import { dispatcherFor, undiciProxyFetch } from "../src/infra/outbound/proxy-dispatcher.js";

// Прокси для исходящих запросов (docs/35-stage4-plan.md Р91, tasks/T-0065):
// порядок попыток, что считается неудачей, пределы времени, память о сработавшем
// прокси, запись каждой попытки в журнал и настоящие прокси на localhost.

const NOW = new Date("2026-10-29T10:00:00.000Z");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const proxyOf = (id: string, priority: number, extra: Partial<OutboundProxy> = {}): OutboundProxy => ({
  id,
  scheme: "http",
  host: `${id}.example.com`,
  port: 3128,
  username: null,
  password: null,
  priority,
  updatedAt: 1,
  ...extra,
});

describe("порядок попыток", () => {
  const two = [
    { id: "p1", priority: 10 },
    { id: "p2", priority: 20 },
  ];

  it("direct_first с двумя прокси: напрямую, затем по порядку", () => {
    expect(attemptPlan("direct_first", two, null)).toEqual(["direct", "p1", "p2"]);
  });

  it("порядок задаёт priority, а не порядок в списке; при равных — как в списке", () => {
    expect(attemptPlan("direct_first", [{ id: "late", priority: 30 }, { id: "a", priority: 5 }, { id: "b", priority: 5 }], null)).toEqual(["direct", "a", "b", "late"]);
  });

  it("запомнен p2: он первый среди прокси, но не раньше прямой попытки", () => {
    expect(attemptPlan("direct_first", two, "p2")).toEqual(["direct", "p2", "p1"]);
  });

  it("запомненный прокси, которого нет в списке (выключен или удалён), ничего не меняет", () => {
    expect(attemptPlan("direct_first", two, "gone")).toEqual(["direct", "p1", "p2"]);
  });

  it("proxy_only: без direct", () => {
    expect(attemptPlan("proxy_only", two, null)).toEqual(["p1", "p2"]);
    expect(attemptPlan("proxy_only", two, "p2")).toEqual(["p2", "p1"]);
  });

  it("direct_only: только direct, прокси и память не нужны", () => {
    expect(attemptPlan("direct_only", two, null)).toEqual(["direct"]);
    expect(attemptPlan("direct_only", two, "p2")).toEqual(["direct"]);
  });

  it("прокси нет: direct_first — только direct, proxy_only — пустой план", () => {
    expect(attemptPlan("direct_first", [], null)).toEqual(["direct"]);
    expect(attemptPlan("proxy_only", [], null)).toEqual([]);
  });

  it("входной список не меняется", () => {
    const input = [...two].reverse();
    attemptPlan("direct_first", input, "p1");
    expect(input.map((item) => item.id)).toEqual(["p2", "p1"]);
  });
});

describe("что считается неудачей", () => {
  it.each([
    [{ status: null, error: "network" }, "сетевой сбой"],
    [{ status: null, error: "timeout" }, "таймаут попытки"],
    [{ status: 403, error: null }, "403 — отказ по стране"],
    [{ status: 451, error: null }, "451 — недоступно по закону"],
  ])("%j (%s) — к следующей попытке", (outcome) => {
    expect(shouldFallBack(outcome)).toBe(true);
  });

  it.each([
    [{ status: 200, error: null }],
    [{ status: 204, error: null }],
    [{ status: 401, error: null }],
    [{ status: 404, error: null }],
    [{ status: 429, error: null }],
    [{ status: 500, error: null }],
    [{ status: 503, error: null }],
  ])("%j — ответ сервиса: прокси его не исправит", (outcome) => {
    expect(shouldFallBack(outcome)).toBe(false);
  });

  it("отмена вызывающим — не повод пробовать дальше", () => {
    expect(shouldFallBack({ status: null, error: "aborted" })).toBe(false);
  });
});

describe("режим сервиса по умолчанию", () => {
  it("Bot API — только напрямую: токен бота в адресе не уходит чужому серверу", () => {
    expect(defaultModeOf("telegram.bot")).toBe("direct_only");
  });

  it("остальные сервисы — сначала напрямую", () => {
    for (const service of OUTBOUND_SERVICES.filter((item) => item !== "telegram.bot")) expect(defaultModeOf(service), service).toBe("direct_first");
  });

  it("пределы и память: 3 с напрямую, 5 с через прокси, 10 минут", () => {
    expect([DIRECT_ATTEMPT_MS, PROXY_ATTEMPT_MS, ROUTE_MEMORY_SEC]).toEqual([3_000, 5_000, 600]);
  });
});

/** Память о маршруте в виде словаря: то, что Redis хранит по `outbound:route:<сервис>`. */
class FakeMemory implements RouteMemory {
  readonly saved: [string, string][] = [];
  constructor(private remembered: string | null = null) {}
  async get(): Promise<string | null> {
    return this.remembered;
  }
  async remember(service: string, proxyId: string): Promise<void> {
    this.saved.push([service, proxyId]);
    this.remembered = proxyId;
  }
}

function capture(): { sink: OutboundSink; records: OutboundRecord[] } {
  const records: OutboundRecord[] = [];
  return { records, sink: { write: (record) => void records.push(record) } };
}

type Responder = (input: unknown, init?: RequestInit) => Promise<Response> | Response;
type ViaProxy = (proxy: OutboundProxy, input: unknown, init?: RequestInit) => Promise<Response> | Response;

interface Setup {
  mode?: OutboundMode;
  proxies?: OutboundProxy[];
  memory?: RouteMemory;
  direct?: Responder;
  viaProxy?: ViaProxy;
  service?: (typeof OUTBOUND_SERVICES)[number];
  modeOf?: OutboundRoutes["modeOf"];
}

/** Клиент на подменах: прямой `fetch` — глобальный, через прокси — подмена `ProxyFetch`. */
function setup(options: Setup = {}) {
  const { sink, records } = capture();
  const directCalls: { input: unknown; init: RequestInit | undefined }[] = [];
  const proxyCalls: { proxy: OutboundProxy; input: unknown; init: RequestInit | undefined }[] = [];
  const direct = options.direct ?? (() => new Response("прямо"));
  const viaProxy = options.viaProxy ?? (() => new Response("через прокси"));
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    directCalls.push({ input, init });
    return await direct(input, init);
  });
  const proxyFetch: ProxyFetch = async (proxy, input, init) => {
    proxyCalls.push({ proxy, input, init });
    return await viaProxy(proxy, input, init);
  };
  const proxies = options.proxies ?? [proxyOf("p1", 10), proxyOf("p2", 20)];
  const mode = options.mode ?? "direct_first";
  const routes: OutboundRoutes = { list: () => proxies, modeOf: options.modeOf ?? (() => mode) };
  const memory = options.memory ?? new FakeMemory();
  const client = new Outbound(sink, () => NOW, routes, memory, proxyFetch).forService(options.service ?? "fx.cbr");
  return { client, records, directCalls, proxyCalls, memory };
}

const networkFailure = (): Promise<Response> => Promise.reject(new TypeError("fetch failed"));
/** Попытка, которая не отвечает, пока её не прервёт сигнал, — ровно как живой `fetch`. */
const hang: Responder = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal === undefined || signal === null) return;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

describe("клиент с прокси", () => {
  it("прямой упал по сети, первый прокси ответил 200: вызывающий получил 200, две записи, прокси запомнен", async () => {
    const memory = new FakeMemory();
    const { client, records, directCalls, proxyCalls } = setup({ direct: networkFailure, memory });

    const response = await client("https://api.example.com/rates?x=1");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("через прокси");
    expect(directCalls).toHaveLength(1);
    expect(proxyCalls.map((call) => call.proxy.id)).toEqual(["p1"]);
    expect(records.map((record) => [record.via, record.attempt, record.status, record.ok, record.error])).toEqual([
      ["direct", 1, null, false, "network"],
      ["p1", 2, 200, true, null],
    ]);
    expect(records[0]).toMatchObject({ service: "fx.cbr", host: "api.example.com", path: "/rates", at: NOW });
    await vi.waitFor(() => expect(memory.saved).toEqual([["fx.cbr", "p1"]]));
  });

  it("403 и 451 напрямую — отказ по стране: пробуем прокси, тело отказа отпущено", async () => {
    for (const status of [403, 451]) {
      const cancelled = vi.fn();
      const { client, records } = setup({ direct: () => new Response(new ReadableStream({ cancel: cancelled }), { status }) });
      const response = await client("https://api.example.com/x");
      expect(response.status).toBe(200);
      expect(records.map((record) => [record.via, record.status, record.ok])).toEqual([
        ["direct", status, false],
        ["p1", 200, true],
      ]);
      expect(cancelled).toHaveBeenCalledTimes(1);
    }
  });

  it("500 и 404 — ответ сервиса: одна попытка, прокси не трогаются, память не пишется", async () => {
    for (const status of [500, 404]) {
      const memory = new FakeMemory();
      const { client, records, proxyCalls } = setup({ direct: () => new Response("нет", { status }), memory });
      const response = await client("https://api.example.com/x");
      expect(response.status).toBe(status);
      expect(proxyCalls).toHaveLength(0);
      expect(records).toHaveLength(1);
      expect(memory.saved).toEqual([]);
    }
  });

  it("напрямую прошло: прокси не трогаются", async () => {
    const { client, proxyCalls, records } = setup();
    expect((await client("https://api.example.com/x")).status).toBe(200);
    expect(proxyCalls).toHaveLength(0);
    expect(records.map((record) => record.via)).toEqual(["direct"]);
  });

  it("запомнен p2: после прямой попытки идёт первым он, а p1 — только если p2 не прошёл", async () => {
    const { client, proxyCalls, records } = setup({
      direct: networkFailure,
      memory: new FakeMemory("p2"),
      viaProxy: (proxy) => (proxy.id === "p2" ? Promise.reject(new TypeError("fetch failed")) : new Response("ok")),
    });
    expect((await client("https://api.example.com/x")).status).toBe(200);
    expect(proxyCalls.map((call) => call.proxy.id)).toEqual(["p2", "p1"]);
    expect(records.map((record) => [record.via, record.attempt])).toEqual([
      ["direct", 1],
      ["p2", 2],
      ["p1", 3],
    ]);
  });

  it("не прошёл ни один: исключение последней попытки, записей по числу попыток", async () => {
    const lastFailure = new TypeError("конец");
    const { client, records } = setup({ direct: networkFailure, viaProxy: (proxy) => (proxy.id === "p2" ? Promise.reject(lastFailure) : networkFailure()) });
    await expect(client("https://api.example.com/x")).rejects.toBe(lastFailure);
    expect(records.map((record) => [record.via, record.ok, record.error])).toEqual([
      ["direct", false, "network"],
      ["p1", false, "network"],
      ["p2", false, "network"],
    ]);
  });

  it("403 везде: вызывающий получает последний ответ, а не исключение", async () => {
    const { client } = setup({ direct: () => new Response("a", { status: 403 }), viaProxy: () => new Response("b", { status: 403 }) });
    const response = await client("https://api.example.com/x");
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("b");
  });

  it("direct_only: прокси не пробуются даже при сбое", async () => {
    const { client, proxyCalls, records } = setup({ mode: "direct_only", direct: networkFailure });
    await expect(client("https://api.example.com/x")).rejects.toBeInstanceOf(TypeError);
    expect(proxyCalls).toHaveLength(0);
    expect(records).toHaveLength(1);
  });

  it("Bot API по умолчанию — только напрямую, как бы ни настроили прокси", async () => {
    const { client, proxyCalls } = setup({ service: "telegram.bot", modeOf: defaultModeOf, direct: () => new Response("запрещено", { status: 403 }) });
    expect((await client("https://api.telegram.org/bot1:SECRET/getMe")).status).toBe(403);
    expect(proxyCalls).toHaveLength(0);
  });

  it("proxy_only: прямого пути нет вовсе, ждать его таймаут незачем", async () => {
    const { client, directCalls, proxyCalls, records } = setup({ mode: "proxy_only" });
    expect((await client("https://api.example.com/x")).status).toBe(200);
    expect(directCalls).toHaveLength(0);
    expect(proxyCalls.map((call) => call.proxy.id)).toEqual(["p1"]);
    expect(records.map((record) => [record.via, record.attempt])).toEqual([["p1", 1]]);
  });

  it("proxy_only без включённых прокси: понятная ошибка, ни одного запроса и ни одной записи", async () => {
    const { client, directCalls, proxyCalls, records } = setup({ mode: "proxy_only", proxies: [] });
    await expect(client("https://api.example.com/x")).rejects.toBeInstanceOf(OutboundNoRouteError);
    await expect(client("https://api.example.com/x")).rejects.toThrow(/fx\.cbr/);
    expect([directCalls.length, proxyCalls.length, records.length]).toEqual([0, 0, 0]);
  });

  it("без порта прокси клиент работает как раньше: одна прямая попытка", async () => {
    const { sink, records } = capture();
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", async (input: unknown) => {
      calls.push(input);
      return new Response("ok");
    });
    const client = new Outbound(sink, () => NOW).forService("fx.cbr");
    expect((await client("https://api.example.com/x")).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(records.map((record) => [record.via, record.attempt])).toEqual([["direct", 1]]);
  });
});

describe("тело запроса", () => {
  it("поток повторно не отправить: одна попытка, прокси не трогаются", async () => {
    const { client, proxyCalls, records } = setup({ direct: networkFailure });
    const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
    await expect(client("https://api.example.com/x", { method: "POST", body, duplex: "half" } as RequestInit)).rejects.toBeInstanceOf(TypeError);
    expect(proxyCalls).toHaveLength(0);
    expect(records).toHaveLength(1);
  });

  it("запрос-объект с телом тоже идёт одной попыткой", async () => {
    const { client, proxyCalls } = setup({ direct: networkFailure });
    await expect(client(new Request("https://api.example.com/x", { method: "POST", body: "тело" }))).rejects.toBeInstanceOf(TypeError);
    expect(proxyCalls).toHaveLength(0);
  });

  it("строка и байты уходят на каждую попытку целиком", async () => {
    for (const body of ["строка", new TextEncoder().encode("байты"), new URLSearchParams({ a: "1" })]) {
      const { client, proxyCalls } = setup({ direct: networkFailure });
      await client("https://api.example.com/x", { method: "POST", body });
      expect(proxyCalls[0]?.init?.body).toBe(body);
    }
  });

  it("при потоковом теле и режиме proxy_only единственная попытка — через первый прокси", async () => {
    const { client, directCalls, proxyCalls } = setup({ mode: "proxy_only" });
    const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
    await client("https://api.example.com/x", { method: "POST", body, duplex: "half" } as RequestInit);
    expect([directCalls.length, proxyCalls.map((call) => call.proxy.id)]).toEqual([0, ["p1"]]);
  });
});

describe("время и отмена", () => {
  it("прямая попытка, когда есть куда переходить, ограничена 3 с, дальше — прокси", async () => {
    vi.useFakeTimers();
    const { client, records, proxyCalls } = setup({ direct: hang });
    const pending = client("https://api.example.com/x");

    await vi.advanceTimersByTimeAsync(DIRECT_ATTEMPT_MS - 1);
    expect(proxyCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect((await pending).status).toBe(200);
    expect(records[0]).toMatchObject({ via: "direct", ok: false, error: "timeout" });
    expect(records[1]).toMatchObject({ via: "p1", ok: true });
  });

  it("попытка через прокси, за которой есть ещё прокси, ограничена 5 с", async () => {
    vi.useFakeTimers();
    const { client, records, proxyCalls } = setup({ mode: "proxy_only", viaProxy: (proxy, input, init) => (proxy.id === "p1" ? hang(input, init) : new Response("p2")) });
    const pending = client("https://api.example.com/x");

    await vi.advanceTimersByTimeAsync(PROXY_ATTEMPT_MS - 1);
    expect(proxyCalls.map((call) => call.proxy.id)).toEqual(["p1"]);
    await vi.advanceTimersByTimeAsync(1);

    expect(await (await pending).text()).toBe("p2");
    expect(records[0]).toMatchObject({ via: "p1", error: "timeout" });
  });

  it("у последней попытки своего предела нет: ей отдан сигнал вызывающего как есть", async () => {
    const caller = new AbortController();
    const { client, directCalls, proxyCalls } = setup({ direct: networkFailure, proxies: [proxyOf("p1", 10)] });
    await client("https://api.example.com/x", { signal: caller.signal });
    expect(directCalls[0]?.init?.signal).not.toBe(caller.signal);
    expect(proxyCalls[0]?.init?.signal).toBe(caller.signal);
  });

  it("единственная попытка идёт без своего предела, даже без сигнала вызывающего", async () => {
    const { client, directCalls } = setup({ mode: "direct_only" });
    await client("https://api.example.com/x");
    expect(directCalls[0]?.init?.signal).toBeUndefined();
  });

  it("сигнал вызывающего — общий предел: отмена посреди попытки не ведёт к следующей", async () => {
    const caller = new AbortController();
    const { client, records, proxyCalls } = setup({ direct: hang });
    const pending = client("https://api.example.com/x", { signal: caller.signal });
    caller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(proxyCalls).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ via: "direct", ok: false, error: "aborted" });
  });

  it("срок вызывающего вышел посреди прямой попытки — это его таймаут, а не повод идти в прокси", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const timer = setTimeout(() => caller.abort(new DOMException("срок", "TimeoutError")), 1_000);
    const { client, records, proxyCalls } = setup({ direct: hang });
    const pending = client("https://api.example.com/x", { signal: caller.signal });
    const outcome = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });

    await vi.advanceTimersByTimeAsync(1_000);

    await outcome;
    clearTimeout(timer);
    expect(proxyCalls).toHaveLength(0);
    expect(records[0]).toMatchObject({ error: "timeout" });
  });

  it("уже отменённый сигнал: ни одной попытки дальше первой", async () => {
    const caller = new AbortController();
    caller.abort();
    const { client, proxyCalls } = setup({ direct: (_input, init) => Promise.reject(init?.signal?.reason) });
    await expect(client("https://api.example.com/x", { signal: caller.signal })).rejects.toBeDefined();
    expect(proxyCalls).toHaveLength(0);
  });
});

describe("память о маршруте", () => {
  it("прошёл через прокси даже с ответом 404 — это ответ сервиса, прокси запоминается", async () => {
    const memory = new FakeMemory();
    const { client } = setup({ direct: networkFailure, viaProxy: () => new Response("нет", { status: 404 }), memory });
    expect((await client("https://api.example.com/x")).status).toBe(404);
    await vi.waitFor(() => expect(memory.saved).toEqual([["fx.cbr", "p1"]]));
  });

  it("прошёл напрямую — память не трогается", async () => {
    const memory = new FakeMemory("p2");
    const { client } = setup({ memory });
    await client("https://api.example.com/x");
    expect(memory.saved).toEqual([]);
  });

  it("сбой чтения памяти: план без запомненного, вызов не падает", async () => {
    const memory: RouteMemory = { get: () => Promise.reject(new Error("redis лежит")), remember: async () => undefined };
    const { client, proxyCalls } = setup({ direct: networkFailure, memory });
    expect((await client("https://api.example.com/x")).status).toBe(200);
    expect(proxyCalls.map((call) => call.proxy.id)).toEqual(["p1"]);
  });

  it("сбой записи в память не роняет вызов и не оставляет необработанного отказа", async () => {
    const memory: RouteMemory = { get: async () => null, remember: () => Promise.reject(new Error("redis лежит")) };
    const { client } = setup({ direct: networkFailure, memory });
    expect((await client("https://api.example.com/x")).status).toBe(200);
    // Необработанный отказ vitest засчитывает файлу как ошибку сам; даём ему случиться.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("память не зовётся там, где выбирать не из чего: direct_only и пустой список прокси", async () => {
    const get = vi.fn(async () => null);
    const memory: RouteMemory = { get, remember: async () => undefined };
    await setup({ mode: "direct_only", memory }).client("https://api.example.com/x");
    await setup({ proxies: [], memory }).client("https://api.example.com/x");
    expect(get).not.toHaveBeenCalled();
  });
});

describe("запись попытки без секретов", () => {
  it("в журнале — id прокси, а не его адрес, логин или пароль", async () => {
    const secret = proxyOf("11111111-1111-4111-8111-111111111111", 10, { username: "user-xyz", password: "pa55-word-QQQ", host: "tunnel.internal", port: 1080 });
    const { client, records } = setup({ direct: networkFailure, proxies: [secret] });
    await client("https://api.example.com/path?key=SECRETSECRETSECRETSECRET1");
    const text = JSON.stringify(records);
    expect(text).toContain(secret.id);
    for (const leak of ["user-xyz", "pa55-word-QQQ", "tunnel.internal", "SECRETSECRET"]) expect(text, leak).not.toContain(leak);
  });
});

describe("диспетчер прокси", () => {
  it("http и https — ProxyAgent, socks5 — Agent с SOCKS-соединением", () => {
    expect(dispatcherFor(proxyOf("h", 1, { scheme: "http" }))).toBeInstanceOf(ProxyAgent);
    expect(dispatcherFor(proxyOf("s", 1, { scheme: "https", port: 8443 }))).toBeInstanceOf(ProxyAgent);
    const socks = dispatcherFor(proxyOf("k", 1, { scheme: "socks5", port: 1080 }));
    expect(socks).toBeInstanceOf(Agent);
    expect(socks).not.toBeInstanceOf(ProxyAgent);
  });

  it("кэш по id и updatedAt: тот же прокси — тот же диспетчер, правка — новый", () => {
    const first = dispatcherFor(proxyOf("cache-1", 1, { updatedAt: 100 }));
    expect(dispatcherFor(proxyOf("cache-1", 1, { updatedAt: 100 }))).toBe(first);
    expect(dispatcherFor(proxyOf("cache-1", 1, { updatedAt: 200 }))).not.toBe(first);
    expect(dispatcherFor(proxyOf("cache-2", 1, { updatedAt: 100 }))).not.toBe(first);
  });

  it("адрес IPv6 берётся в скобки, иначе порт не отделить", () => {
    expect(() => dispatcherFor(proxyOf("v6", 1, { host: "2001:db8::1", port: 3128 }))).not.toThrow();
  });
});

interface Listening {
  port: number;
  close: () => Promise<void>;
}

async function listen(server: Server | TcpServer): Promise<Listening> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

describe("настоящие прокси на localhost", () => {
  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()));
  });

  /** «Целевой» сервис: отвечает своим именем, чтобы было видно, что ответ дошёл по цепочке. */
  async function target(): Promise<Listening> {
    const server = createServer((_request, response) => response.end("целевой сервис"));
    const listening = await listen(server);
    stops.push(listening.close);
    return listening;
  }

  it("HTTP-прокси: запрос приходит на прокси с адресом цели и Basic-логином", async () => {
    const seen: { url: string | undefined; headers: IncomingHttpHeaders }[] = [];
    const proxy = createServer((request, response) => {
      seen.push({ url: request.url, headers: request.headers });
      response.end("ответил прокси");
    });
    const listening = await listen(proxy);
    stops.push(listening.close);

    const response = await undiciProxyFetch(proxyOf("http-1", 1, { host: "127.0.0.1", port: listening.port, username: "user", password: "p@ss:word" }), "http://target.invalid/path?a=1", {});

    expect(await response.text()).toBe("ответил прокси");
    expect(seen[0]?.url).toBe("http://target.invalid/path?a=1");
    expect(seen[0]?.headers["proxy-authorization"]).toBe(`Basic ${Buffer.from("user:p@ss:word").toString("base64")}`);
  });

  it("HTTP-прокси без логина: заголовка авторизации нет", async () => {
    const headers: IncomingHttpHeaders[] = [];
    const proxy = createServer((request, response) => {
      headers.push(request.headers);
      response.end("ok");
    });
    const listening = await listen(proxy);
    stops.push(listening.close);
    await (await undiciProxyFetch(proxyOf("http-2", 1, { host: "127.0.0.1", port: listening.port }), "http://target.invalid/", {})).text();
    expect(headers[0]?.["proxy-authorization"]).toBeUndefined();
  });

  /** Минимальный SOCKS5: рукопожатие (без пароля или с ним), CONNECT и трубопровод к цели. */
  async function socks5(credentials: { user: string; pass: string } | null) {
    const state: { login: { user: string; pass: string } | null; targets: string[] } = { login: null, targets: [] };
    const server = createTcpServer((client: Socket) => {
      const connectRequest = (): void => {
        client.once("data", (request: Buffer) => {
          const kind = request[3];
          let host: string;
          let offset: number;
          if (kind === 1) {
            host = [...request.subarray(4, 8)].join(".");
            offset = 8;
          } else if (kind === 3) {
            const length = request[4] ?? 0;
            host = request.subarray(5, 5 + length).toString("utf8");
            offset = 5 + length;
          } else {
            client.destroy();
            return;
          }
          const port = request.readUInt16BE(offset);
          state.targets.push(`${host}:${String(port)}`);
          const upstream = connect(port, host === "target.invalid" ? "127.0.0.1" : host, () => {
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            client.pipe(upstream);
            upstream.pipe(client);
          });
          upstream.on("error", () => client.destroy());
          client.on("error", () => upstream.destroy());
        });
      };
      client.once("data", (greeting: Buffer) => {
        const methods = [...greeting.subarray(2, 2 + (greeting[1] ?? 0))];
        if (credentials === null) {
          client.write(Buffer.from([5, 0]));
          connectRequest();
          return;
        }
        if (!methods.includes(2)) {
          client.end(Buffer.from([5, 0xff]));
          return;
        }
        client.write(Buffer.from([5, 2]));
        client.once("data", (auth: Buffer) => {
          const userLength = auth[1] ?? 0;
          const user = auth.subarray(2, 2 + userLength).toString("utf8");
          const pass = auth.subarray(3 + userLength, 3 + userLength + (auth[2 + userLength] ?? 0)).toString("utf8");
          state.login = { user, pass };
          const accepted = user === credentials.user && pass === credentials.pass;
          client.write(Buffer.from([1, accepted ? 0 : 1]));
          if (accepted) connectRequest();
          else client.end();
        });
      });
      client.on("error", () => undefined);
    });
    const listening = await listen(server);
    stops.push(listening.close);
    return { ...listening, state };
  }

  it("SOCKS5 без пароля: запрос доходит до цели через туннель", async () => {
    const service = await target();
    const tunnel = await socks5(null);
    const response = await undiciProxyFetch(proxyOf("socks-1", 1, { scheme: "socks5", host: "127.0.0.1", port: tunnel.port }), `http://target.invalid:${String(service.port)}/`, {});
    expect(await response.text()).toBe("целевой сервис");
    expect(tunnel.state.targets).toEqual([`target.invalid:${String(service.port)}`]);
  });

  it("SOCKS5 с логином и паролем: сервер видит учётные данные из настроек", async () => {
    const service = await target();
    const tunnel = await socks5({ user: "tunnel-user", pass: "tunnel-pass" });
    const response = await undiciProxyFetch(
      proxyOf("socks-2", 1, { scheme: "socks5", host: "127.0.0.1", port: tunnel.port, username: "tunnel-user", password: "tunnel-pass" }),
      `http://target.invalid:${String(service.port)}/`,
      {},
    );
    expect(await response.text()).toBe("целевой сервис");
    expect(tunnel.state.login).toEqual({ user: "tunnel-user", pass: "tunnel-pass" });
  });

  it("SOCKS5 с чужим паролем: запрос не проходит", async () => {
    const service = await target();
    const tunnel = await socks5({ user: "tunnel-user", pass: "tunnel-pass" });
    await expect(
      undiciProxyFetch(proxyOf("socks-3", 1, { scheme: "socks5", host: "127.0.0.1", port: tunnel.port, username: "tunnel-user", password: "wrong" }), `http://target.invalid:${String(service.port)}/`, {}),
    ).rejects.toBeInstanceOf(Error);
  });

  it("весь путь: прямая попытка упала, ответ дал настоящий HTTP-прокси, он же запомнен", async () => {
    const proxy = createServer((_request, response) => response.end("через настоящий прокси"));
    const listening = await listen(proxy);
    stops.push(listening.close);
    const memory = new FakeMemory();
    const { sink, records } = capture();
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
    const routes: OutboundRoutes = { list: () => [proxyOf("real-1", 1, { host: "127.0.0.1", port: listening.port })], modeOf: () => "direct_first" };
    const client = new Outbound(sink, () => NOW, routes, memory, undiciProxyFetch).forService("fx.cbr");

    const response = await client("http://api.invalid/rates");

    expect(await response.text()).toBe("через настоящий прокси");
    expect(records.map((record) => [record.via, record.ok])).toEqual([
      ["direct", false],
      ["real-1", true],
    ]);
    await vi.waitFor(() => expect(memory.saved).toEqual([["fx.cbr", "real-1"]]));
  });
});
