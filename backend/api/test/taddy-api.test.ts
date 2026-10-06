import { describe, expect, it } from "vitest";
import { HttpTaddyApi, adOf, httpsUrl, type TaddyUser } from "../src/modules/ads/taddy-api.js";

/**
 * Taddy по API (docs/35-stage4-plan.md WP12, часть 9): креатив для нашего
 * блока, отметки показа и досмотра, запуск бота — на поддельном `fetch`.
 */

const PUB_ID = "14cbeb980853dd416003462ca4db7c12";
const USER: TaddyUser = { id: 777000111, language: "ru", premium: true, ip: "203.0.113.7", userAgent: "TelegramBot/1.0" };

const AD = {
  id: "ad-42",
  title: "Рубеж держит",
  description: "Описание",
  image: "https://cdn.example/ad.png",
  icon: "https://cdn.example/icon.png",
  text: "Текст",
  button: "Открыть",
  link: "https://t.me/example_bot?start=taddy",
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

describe("Taddy: креатив", () => {
  it("объявление — с данными игрока для гео и антифрода, от имени сервера", async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ result: AD }));
    const result = await new HttpTaddyApi(fetchImpl).getAd(PUB_ID, USER);
    expect(result).toEqual({ kind: "ad", ad: { ...AD } });
    expect(calls[0]?.url).toBe("https://api.taddy.pro/v1/ads/get");
    expect(calls[0]?.body).toEqual({ pubId: PUB_ID, user: USER, origin: "server", format: "app-interstitial" });
  });

  it("пустой ответ — нет рекламы, а не поломка", async () => {
    const { fetchImpl } = fakeFetch(() => json({ result: null }));
    expect(await new HttpTaddyApi(fetchImpl).getAd(PUB_ID, USER)).toEqual({ kind: "none", reason: "no_fill" });
    expect(adOf({})).toEqual({ kind: "none", reason: "no_fill" });
  });

  it("ошибка сети, код ответа и таймаут — отказ с причиной, без исключения", async () => {
    const failing = fakeFetch(() => json({ error: "pubId not found", code: 404 }));
    expect(await new HttpTaddyApi(failing.fetchImpl).getAd(PUB_ID, USER)).toEqual({ kind: "none", reason: "api_error" });

    const down = fakeFetch(() => new Response("bad gateway", { status: 502 }));
    expect(await new HttpTaddyApi(down.fetchImpl).getAd(PUB_ID, USER)).toEqual({ kind: "none", reason: "api_error" });

    const slow = fakeFetch(() => Promise.reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
    expect(await new HttpTaddyApi(slow.fetchImpl).getAd(PUB_ID, USER)).toEqual({ kind: "none", reason: "timeout" });

    const garbage = fakeFetch(() => new Response("<html>", { status: 200 }));
    expect(await new HttpTaddyApi(garbage.fetchImpl).getAd(PUB_ID, USER)).toEqual({ kind: "none", reason: "api_error" });
  });

  it("небезопасный адрес в наш блок не попадает: ссылка без https — не объявление, картинка — пропадает", () => {
    expect(adOf({ result: { ...AD, link: "javascript:alert(1)" } })).toEqual({ kind: "none", reason: "invalid" });
    expect(adOf({ result: { ...AD, link: "http://example.com" } })).toEqual({ kind: "none", reason: "invalid" });
    const result = adOf({ result: { ...AD, image: "http://cdn.example/ad.png", icon: "data:image/png;base64,AAAA" } });
    expect(result.kind === "ad" ? [result.ad.image, result.ad.icon] : null).toEqual([null, null]);
  });

  it("объявление без заголовка и без картинки показать нечем; пустые строки — как поля нет", () => {
    expect(adOf({ result: { id: 1, link: AD.link, title: "  ", image: null } })).toEqual({ kind: "none", reason: "invalid" });
    const result = adOf({ result: { id: 7, link: AD.link, title: "Заголовок", button: "", description: null } });
    expect(result).toEqual({
      kind: "ad",
      ad: { id: "7", title: "Заголовок", description: null, text: null, image: null, icon: null, button: null, link: AD.link },
    });
  });

  it("длинный текст обрезается, а не роняет блок", () => {
    const result = adOf({ result: { ...AD, title: "я".repeat(500), button: "к".repeat(200) } });
    expect(result.kind === "ad" ? [result.ad.title?.length, result.ad.button?.length] : null).toEqual([200, 60]);
  });

  it("https-адрес нормализуется, мусор и слишком длинный — нет", () => {
    expect(httpsUrl("https://Example.com/a b")).toBe("https://example.com/a%20b");
    expect(httpsUrl("не адрес")).toBeNull();
    expect(httpsUrl(`https://example.com/${"a".repeat(3000)}`)).toBeNull();
    expect(httpsUrl(null)).toBeNull();
  });
});

describe("Taddy: отметки", () => {
  it("показ, досмотр и запуск бота — с pubId и игроком; параметр запуска — только если был", async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ result: true }));
    const api = new HttpTaddyApi(fetchImpl);
    await api.impression(PUB_ID, USER, "ad-42");
    await api.viewThrough(PUB_ID, USER, "ad-42");
    await api.start(PUB_ID, { id: USER.id, language: "en" }, "ref_abc");
    await api.start(PUB_ID, { id: USER.id }, null);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.taddy.pro/v1/ads/impressions",
      "https://api.taddy.pro/v1/ads/view-through",
      "https://api.taddy.pro/v1/events/start",
      "https://api.taddy.pro/v1/events/start",
    ]);
    expect(calls[0]?.body).toEqual({ pubId: PUB_ID, user: USER, origin: "server", id: "ad-42" });
    expect(calls[2]?.body).toEqual({ pubId: PUB_ID, user: { id: USER.id, language: "en" }, origin: "server", start: "ref_abc" });
    expect(calls[3]?.body).not.toHaveProperty("start");
  });

  it("отметка, которую сеть не приняла, не бросает: игрок её не ждёт", async () => {
    const down = fakeFetch(() => Promise.reject(new Error("ECONNRESET")));
    await expect(new HttpTaddyApi(down.fetchImpl).impression(PUB_ID, USER, "ad-42")).resolves.toBeUndefined();
    const rejected = fakeFetch(() => new Response("", { status: 500 }));
    await expect(new HttpTaddyApi(rejected.fetchImpl).start(PUB_ID, USER, null)).resolves.toBeUndefined();
  });
});
