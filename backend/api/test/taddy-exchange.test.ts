import { describe, expect, it } from "vitest";
import type { TaddyUser } from "../src/modules/ads/taddy-api.js";
import { HttpTaddyExchange, TADDY_FEED_LIMIT, checkOf, exchangeTaskOf, feedOf, wireId } from "../src/modules/ads/taddy-exchange.js";

/**
 * Лента обмена Taddy (docs/35-stage4-plan.md WP13, часть 6): лента, показ и
 * проверка выполнения — на поддельном `fetch`, по контракту SDK Taddy.
 */

const PUB_ID = "14cbeb980853dd416003462ca4db7c12";
const USER: TaddyUser = { id: 777000111, language: "ru", ip: "203.0.113.7", userAgent: "TelegramBot/1.0" };

const ITEM = {
  id: 9001,
  uid: "u-9001",
  title: "Ферма котиков",
  description: "Запусти бота и забери котика",
  image: "https://cdn.taddy.example/9001.webp",
  fullImage: "https://cdn.taddy.example/9001-full.webp",
  type: "bot",
  link: "https://t.tadly.pro/v1/exchange/open/abc",
  price: null,
  status: "new",
  createdAt: "2026-10-03T08:00:00Z",
  expiresAt: "2026-10-04T08:00:00Z",
};

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function fakeFetch(respond: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return await respond(String(input));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Taddy: лента обмена", () => {
  it("лента — от имени сервера, без выполненных и без автоматических показов, картинки в webp", async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ result: [ITEM] }));
    const result = await new HttpTaddyExchange(fetchImpl).feed(PUB_ID, USER);
    expect(result).toEqual({
      kind: "feed",
      tasks: [{ id: "9001", title: ITEM.title, description: ITEM.description, image: ITEM.image, type: "bot", link: ITEM.link, pending: false }],
    });
    expect(calls[0]?.url).toBe("https://api.taddy.pro/v1/exchange/feed");
    expect(calls[0]?.body).toEqual({
      pubId: PUB_ID,
      user: USER,
      origin: "server",
      limit: TADDY_FEED_LIMIT,
      imageFormat: "webp",
      autoImpressions: false,
      showCompleted: false,
    });
  });

  it("негодное задание отбрасывается по одному, а не всей лентой", () => {
    const result = feedOf({
      result: [
        { ...ITEM, id: 1, link: "javascript:alert(1)" },
        { ...ITEM, id: 2, link: "http://t.tadly.pro/open" },
        { ...ITEM, id: 3, title: "   " },
        { ...ITEM, id: 4, status: "completed" },
        { ...ITEM, id: "", title: "без id" },
        "мусор",
        { ...ITEM, id: 5, status: "pending", type: "channel", image: "http://cdn/5.png", description: "" },
      ],
    });
    expect(result).toEqual({
      kind: "feed",
      tasks: [{ id: "5", title: ITEM.title, description: null, image: null, type: "link", link: ITEM.link, pending: true }],
    });
  });

  it("пустая лента — не поломка", () => {
    expect(feedOf({ result: [] })).toEqual({ kind: "feed", tasks: [] });
    expect(feedOf({ result: null })).toEqual({ kind: "feed", tasks: [] });
  });

  it("ошибка сети, код ответа, мусор и таймаут — отказ с причиной, без исключения", async () => {
    const failing = fakeFetch(() => json({ error: "pubId not found", code: 404 }));
    expect(await new HttpTaddyExchange(failing.fetchImpl).feed(PUB_ID, USER)).toEqual({ kind: "none", reason: "api_error" });

    const down = fakeFetch(() => new Response("bad gateway", { status: 502 }));
    expect(await new HttpTaddyExchange(down.fetchImpl).feed(PUB_ID, USER)).toEqual({ kind: "none", reason: "api_error" });

    const html = fakeFetch(() => new Response("<html>", { status: 200 }));
    expect(await new HttpTaddyExchange(html.fetchImpl).feed(PUB_ID, USER)).toEqual({ kind: "none", reason: "api_error" });

    const shape = fakeFetch(() => json({ result: { tasks: [] } }));
    expect(await new HttpTaddyExchange(shape.fetchImpl).feed(PUB_ID, USER)).toEqual({ kind: "none", reason: "invalid" });

    const slow = fakeFetch(() => Promise.reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
    expect(await new HttpTaddyExchange(slow.fetchImpl).feed(PUB_ID, USER)).toEqual({ kind: "none", reason: "timeout" });
  });

  it("слишком длинный текст обрезается, а не роняет задание", () => {
    const task = exchangeTaskOf({ ...ITEM, title: "я".repeat(500), description: "ы".repeat(2000) });
    expect([task?.title.length, task?.description?.length]).toEqual([200, 500]);
  });
});

describe("Taddy: проверка и показ задания", () => {
  it("проверка — задание тем же типом, каким пришло: число числом, строка строкой", async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ result: true }));
    const exchange = new HttpTaddyExchange(fetchImpl);
    expect(await exchange.check(PUB_ID, USER, "9001")).toEqual({ kind: "checked", done: true });
    expect(await exchange.check(PUB_ID, USER, "a1b2")).toEqual({ kind: "checked", done: true });
    expect(calls.map((call) => [call.url, call.body["taskId"]])).toEqual([
      ["https://api.taddy.pro/v1/exchange/check", 9001],
      ["https://api.taddy.pro/v1/exchange/check", "a1b2"],
    ]);
    expect(calls[0]?.body).toMatchObject({ pubId: PUB_ID, user: USER, origin: "server" });
  });

  it("выполнено только явное true; нет ответа — не «не выполнено», а отказ: игрок проверит снова", async () => {
    expect(checkOf({ result: false })).toEqual({ kind: "checked", done: false });
    expect(checkOf({ result: null })).toEqual({ kind: "none", reason: "invalid" });
    expect(checkOf({ result: "true" })).toEqual({ kind: "none", reason: "invalid" });
    expect(checkOf({ error: "task not found" })).toEqual({ kind: "none", reason: "api_error" });
    const slow = fakeFetch(() => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    expect(await new HttpTaddyExchange(slow.fetchImpl).check(PUB_ID, USER, "1")).toEqual({ kind: "none", reason: "timeout" });
  });

  it("показ — списком из одного задания; отказ сети не бросает", async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ result: true }));
    await new HttpTaddyExchange(fetchImpl).impression(PUB_ID, USER, "9001");
    expect(calls[0]?.url).toBe("https://api.taddy.pro/v1/exchange/impressions");
    expect(calls[0]?.body).toEqual({ pubId: PUB_ID, user: USER, origin: "server", ids: [9001] });

    const rejected = fakeFetch(() => Promise.reject(new Error("ECONNRESET")));
    await expect(new HttpTaddyExchange(rejected.fetchImpl).impression(PUB_ID, USER, "9001")).resolves.toBeUndefined();
  });

  it("числом отдаётся только то, что точно было числом: ведущий ноль и огромное — строкой", () => {
    expect([wireId("0"), wireId("42"), wireId("042"), wireId("99999999999999999"), wireId("abc"), wireId("-1")]).toEqual([0, 42, "042", "99999999999999999", "abc", "-1"]);
  });
});
