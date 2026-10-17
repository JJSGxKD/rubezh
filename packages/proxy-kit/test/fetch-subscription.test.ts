import { describe, expect, it } from "vitest";
import { fetchSubscription, SubscriptionFetchError, type FetchSubscriptionOptions } from "../src/fetch-subscription.js";

// Загрузка подписки: сеть и проверка адреса приходят аргументами. Адрес
// подписки секретный целиком — в тексте ошибок его нет.

const URL_SECRET = "https://sub.example.com/api/sub/TOKEN-SECRET-123";
const BODY = "vless://11111111-1111-4111-8111-111111111111@example.com:443#a";

interface Call {
  url: string;
  init: RequestInit;
}

function setup(responder: (url: string, call: number) => Response | Promise<Response>, patch: Partial<FetchSubscriptionOptions> = {}) {
  const calls: Call[] = [];
  const checked: string[] = [];
  const options: FetchSubscriptionOptions = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      return await responder(url, calls.length);
    }) as typeof fetch,
    assertAllowed: async (url) => void checked.push(url.href),
    ...patch,
  };
  return { calls, checked, options };
}

async function failure(promise: Promise<unknown>): Promise<SubscriptionFetchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionFetchError);
    return error as SubscriptionFetchError;
  }
  throw new Error("ожидалась ошибка");
}

describe("загрузка подписки", () => {
  it("200: тело и разобранные заголовки; запрос с User-Agent и redirect: manual", async () => {
    const { calls, options } = setup(
      () => new Response(BODY, { status: 200, headers: { "subscription-userinfo": "upload=1; download=2; total=3; expire=4", "profile-update-interval": "12" } }),
    );
    const result = await fetchSubscription(URL_SECRET, options);

    expect(result.body).toBe(BODY);
    expect(result.userInfo).toEqual({ uploadBytes: 1, downloadBytes: 2, totalBytes: 3, expireUnixSec: 4 });
    expect(result.updateIntervalHours).toBe(12);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(new Headers(calls[0]?.init.headers).get("user-agent")).toBe("v2rayN/7.0");
  });

  it("свой User-Agent; без заголовков подписки — null", async () => {
    const { calls, options } = setup(() => new Response(BODY), { userAgent: "kit/1.0" });
    const result = await fetchSubscription(URL_SECRET, options);
    expect(new Headers(calls[0]?.init.headers).get("user-agent")).toBe("kit/1.0");
    expect(result.userInfo).toBeNull();
    expect(result.updateIntervalHours).toBeNull();
  });

  it("адрес и каждый переход проверяются: сначала форма адреса, затем assertAllowed", async () => {
    const { checked, calls, options } = setup((_url, call) => (call === 1 ? new Response(null, { status: 302, headers: { location: "/moved?x=1" } }) : new Response(BODY)));
    const result = await fetchSubscription(URL_SECRET, options);
    expect(result.body).toBe(BODY);
    expect(calls.map((call) => call.url)).toEqual([URL_SECRET, "https://sub.example.com/moved?x=1"]);
    expect(checked).toEqual([URL_SECRET, "https://sub.example.com/moved?x=1"]);
  });

  it("переход на закрытый адрес — blocked_url, второй запрос не сделан", async () => {
    const { calls, options } = setup(() => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } }));
    const error = await failure(fetchSubscription(URL_SECRET, options));
    expect(error.code).toBe("blocked_url");
    expect(calls).toHaveLength(1);
  });

  it("не https и закрытые имена отсекаются до запроса", async () => {
    for (const url of ["http://example.com/sub", "https://localhost/sub", "https://10.0.0.1/sub", "https://user:pw@example.com/sub"]) {
      const { calls, options } = setup(() => new Response(BODY));
      const error = await failure(fetchSubscription(url, options));
      expect(error.code, url).toBe("blocked_url");
      expect(calls, url).toHaveLength(0);
    }
  });

  it("assertAllowed бросил — blocked_url; запрос не сделан", async () => {
    const { calls, options } = setup(() => new Response(BODY), {
      assertAllowed: async () => {
        throw new Error("имя указывает на закрытый адрес");
      },
    });
    const error = await failure(fetchSubscription(URL_SECRET, options));
    expect(error.code).toBe("blocked_url");
    expect(calls).toHaveLength(0);
  });

  it("цепочка из четырёх переходов — too_many_redirects", async () => {
    const { calls, options } = setup((_url, call) => new Response(null, { status: 302, headers: { location: `/hop${call}` } }));
    const error = await failure(fetchSubscription(URL_SECRET, options));
    expect(error.code).toBe("too_many_redirects");
    expect(calls).toHaveLength(4);
  });

  it("переход без Location — http_status", async () => {
    const { options } = setup(() => new Response(null, { status: 302 }));
    expect((await failure(fetchSubscription(URL_SECRET, options))).code).toBe("http_status");
  });

  it("не 2xx — http_status со статусом", async () => {
    const { options } = setup(() => new Response("нет", { status: 403 }));
    const error = await failure(fetchSubscription(URL_SECRET, options));
    expect(error.code).toBe("http_status");
    expect(error.status).toBe(403);
  });

  it("тело больше лимита — too_large, и поток не вычитывается целиком", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 10) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const { options } = setup(() => new Response(stream, { status: 200 }));
    const error = await failure(fetchSubscription(URL_SECRET, options));
    expect(error.code).toBe("too_large");
    expect(pulled).toBeLessThanOrEqual(4);
  });

  it("свой потолок maxBytes", async () => {
    const { options } = setup(() => new Response("x".repeat(100)), { maxBytes: 50 });
    expect((await failure(fetchSubscription(URL_SECRET, options))).code).toBe("too_large");
  });

  it("зависший ответ — timeout", async () => {
    const { options } = setup(
      (_url) => new Promise<Response>(() => undefined),
      { timeoutMs: 20 },
    );
    expect((await failure(fetchSubscription(URL_SECRET, options))).code).toBe("timeout");
  });

  it("зависшее тело — timeout", async () => {
    const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) });
    const { options } = setup(() => new Response(stream), { timeoutMs: 20 });
    expect((await failure(fetchSubscription(URL_SECRET, options))).code).toBe("timeout");
  });

  it("сетевая ошибка — network", async () => {
    const { options } = setup(() => Promise.reject(new TypeError(`fetch failed: ${URL_SECRET}`)));
    expect((await failure(fetchSubscription(URL_SECRET, options))).code).toBe("network");
  });

  it("внешний signal отменяет загрузку", async () => {
    const controller = new AbortController();
    const { options } = setup((_url) => new Promise<Response>(() => undefined), { signal: controller.signal, timeoutMs: 10_000 });
    const pending = failure(fetchSubscription(URL_SECRET, options));
    controller.abort();
    expect((await pending).code).toBe("network");
  });

  it("в тексте ошибок нет адреса подписки, токена и причины из сети", async () => {
    const scenarios: Partial<FetchSubscriptionOptions>[] = [];
    const responders: ((url: string, call: number) => Response | Promise<Response>)[] = [
      () => Promise.reject(new TypeError(`fetch failed: ${URL_SECRET}`)),
      () => new Response("x", { status: 500 }),
      () => new Response(null, { status: 302, headers: { location: "https://10.0.0.1/TOKEN-SECRET-123" } }),
      () => new Response("x".repeat(100)),
    ];
    for (const [index, responder] of responders.entries()) {
      const { options } = setup(responder, index === 3 ? { maxBytes: 10 } : scenarios[index] ?? {});
      const error = await failure(fetchSubscription(URL_SECRET, options));
      for (const part of ["TOKEN-SECRET-123", "sub.example.com", "10.0.0.1", "https://"]) {
        expect(error.message, `${error.code}: ${part}`).not.toContain(part);
      }
    }
  });
});
