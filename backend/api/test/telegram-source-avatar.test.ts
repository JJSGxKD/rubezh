import { describe, expect, it } from "vitest";
import { SourceAvatarRejectedError, SourceAvatarUnavailableError, SourceAvatars, readBounded } from "../src/platforms/ports/source-avatar.js";
import { TelegramApiError, TelegramBotApi } from "../src/platforms/telegram/telegram-bot-api.js";
import { TelegramSourceAvatar, imageTypeOf, isTelegramCdn, ogImageOf, parseBotLink, type SourceBotApi } from "../src/platforms/telegram/telegram-source-avatar.js";

// Картинка источника задания (docs/35-stage4-plan.md Р158): аватарка канала —
// по Bot API, бота и Mini App — с публичной страницы. Сервер ходит только на
// хосты Telegram: чужой адрес, перенаправление и не-картинка дают «нет картинки».

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const CDN = "https://cdn4.telesco.pe/file/avatar.jpg";
const ORIGIN = { origin: () => "https://t.me" };

describe("parseBotLink", () => {
  it("ссылка на бота — имя; на Mini App — имя и приложение; параметры запуска отбрасываются", () => {
    expect(parseBotLink("https://t.me/some_bot", "t.me")).toEqual({ bot: "some_bot", app: null });
    expect(parseBotLink("https://t.me/some_bot?start=rubezh", "t.me")).toEqual({ bot: "some_bot", app: null });
    expect(parseBotLink("https://t.me/some_bot/app?startapp=x", "t.me")).toEqual({ bot: "some_bot", app: "app" });
    expect(parseBotLink("https://t.me/some_bot/", "t.me")).toEqual({ bot: "some_bot", app: null });
  });

  it("не https, чужой хост, пустой путь, лишние сегменты, учётные данные и порт — null", () => {
    for (const url of [
      "http://t.me/x_bot_1",
      "https://evil.example/some_bot",
      "https://t.me/",
      "https://t.me",
      "https://t.me/some_bot/app/extra",
      "https://user@t.me/some_bot",
      "https://t.me:8443/some_bot",
      "https://t.me.evil.io/some_bot",
      "https://t.me/ab",
      "https://t.me/1bot_name",
      "https://t.me/bad-name_bot",
      "https://t.me/some_bot/-app",
      "не ссылка",
    ]) {
      expect(parseBotLink(url, "t.me"), url).toBeNull();
    }
  });

  it("домен из настройки telegram.link-host разбирается так же, как t.me", () => {
    expect(parseBotLink("https://links.example/some_bot/app", "links.example")).toEqual({ bot: "some_bot", app: "app" });
    expect(parseBotLink("https://t.me/some_bot", "links.example")).toEqual({ bot: "some_bot", app: null });
    expect(parseBotLink("https://links.example/some_bot", "t.me")).toBeNull();
    expect(parseBotLink("https://T.ME/some_bot", "t.me")).toEqual({ bot: "some_bot", app: null });
  });
});

describe("ogImageOf", () => {
  it("находит og:image при любом порядке атрибутов, кавычках и регистре", () => {
    expect(ogImageOf(`<head><meta property="og:image" content="${CDN}"></head>`)).toBe(CDN);
    expect(ogImageOf(`<meta content="${CDN}" property="og:image">`)).toBe(CDN);
    expect(ogImageOf(`<META PROPERTY='og:image' CONTENT='${CDN}' />`)).toBe(CDN);
    expect(ogImageOf(`<meta property="og:title" content="x"><meta  property = "og:image"   content = "${CDN}?a=1&amp;b=2">`)).toBe(`${CDN}?a=1&b=2`);
  });

  it("нет мета, пустое значение и чужое свойство — null", () => {
    expect(ogImageOf("<html><head></head></html>")).toBeNull();
    expect(ogImageOf(`<meta property="og:image" content="">`)).toBeNull();
    expect(ogImageOf(`<meta property="og:image:alt" content="${CDN}">`)).toBeNull();
    expect(ogImageOf(`<meta name="twitter:image" content="${CDN}">`)).toBeNull();
  });
});

describe("isTelegramCdn", () => {
  it("https и cdn<N>.telesco.pe или cdn<N>.cdn-telegram.org — да", () => {
    expect(isTelegramCdn(CDN)).toBe(true);
    expect(isTelegramCdn("https://cdn1.cdn-telegram.org/file/x.jpg")).toBe(true);
    expect(isTelegramCdn("https://cdn5.telesco.pe/file/x.jpg?v=1")).toBe(true);
  });

  it("заглушка telegram.org, хвост чужого домена, http, порт, учётные данные и мусор — нет", () => {
    for (const url of [
      "https://telegram.org/img/t_logo.png",
      "https://cdn4.telesco.pe.evil.io/file/x.jpg",
      "https://evil.io/cdn4.telesco.pe/x.jpg",
      "http://cdn4.telesco.pe/file/x.jpg",
      "https://cdn4.telesco.pe:8443/file/x.jpg",
      "https://user@cdn4.telesco.pe/file/x.jpg",
      "https://cdn.telesco.pe/file/x.jpg",
      "https://xcdn4.telesco.pe/file/x.jpg",
      "//cdn4.telesco.pe/file/x.jpg",
      "",
    ]) {
      expect(isTelegramCdn(url), url).toBe(false);
    }
  });
});

describe("imageTypeOf", () => {
  it("тип — по сигнатуре байтов", () => {
    expect(imageTypeOf(JPEG)).toBe("image/jpeg");
    expect(imageTypeOf(PNG)).toBe("image/png");
    expect(imageTypeOf(WEBP)).toBe("image/webp");
  });

  it("HTML, GIF, пустое и обрезанное — null", () => {
    expect(imageTypeOf(new TextEncoder().encode("<html>"))).toBeNull();
    expect(imageTypeOf(new TextEncoder().encode("GIF89a......"))).toBeNull();
    expect(imageTypeOf(new Uint8Array())).toBeNull();
    expect(imageTypeOf(new Uint8Array([0xff, 0xd8]))).toBeNull();
    // RIFF без WEBP — это, например, WAV
    expect(imageTypeOf(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeNull();
  });
});

describe("readBounded", () => {
  it("читает тело целиком, пока оно не больше предела", async () => {
    expect(await readBounded(new Response(JPEG), 100)).toEqual(JPEG);
  });

  it("тело больше предела — null; заявленная длина больше предела — null без чтения", async () => {
    expect(await readBounded(new Response(new Uint8Array(11)), 10)).toBeNull();
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    expect(await readBounded(new Response(body, { headers: { "content-length": "999" } }), 10)).toBeNull();
    expect(canceled).toBe(true);
  });

  it("длинный поток обрывается на пределе, а не читается до конца", async () => {
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(1024));
        if (chunks > 1000) controller.close();
      },
    });
    expect(await readBounded(new Response(body), 4096)).toBeNull();
    expect(chunks).toBeLessThan(20);
  });
});

class FakeBotApi implements SourceBotApi {
  readonly asked: string[] = [];
  photo: string | null = "file-id-1";
  photoError: Error | null = null;
  file: Uint8Array | null = JPEG;
  fileError: Error | null = null;

  async getChatPhoto(chat: string): Promise<string | null> {
    this.asked.push(chat);
    if (this.photoError !== null) throw this.photoError;
    return this.photo;
  }

  async downloadFile(fileId: string): Promise<Uint8Array | null> {
    this.asked.push(`file:${fileId}`);
    if (this.fileError !== null) throw this.fileError;
    return this.file;
  }
}

type Reply = Response | Error | (() => Response);

/** Подставной `fetch`: ответ по адресу; запросы запоминаются. */
function web(replies: Record<string, Reply>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const reply = replies[url];
    if (reply === undefined) throw new Error(`неожиданный запрос ${url}`);
    if (reply instanceof Error) throw reply;
    return typeof reply === "function" ? reply() : reply;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const page = (image: string) => new Response(`<html><head><meta property="og:image" content="${image}"></head></html>`, { status: 200, headers: { "content-type": "text/html" } });

function adapter(replies: Record<string, Reply> = {}, api = new FakeBotApi(), enabled = true) {
  const { fetchImpl, calls } = web(replies);
  return { api, calls, avatar: new TelegramSourceAvatar(api, ORIGIN, fetchImpl, enabled) };
}

const signal = new AbortController().signal;

describe("аватарка канала Telegram", () => {
  it("есть фото — байты из Bot API", async () => {
    const { api, avatar } = adapter();
    const image = await avatar.fetch({ kind: "channel", chat: "@rubezh_game" }, signal);
    expect(image).toEqual({ bytes: JPEG, contentType: "image/jpeg" });
    expect(api.asked).toEqual(["@rubezh_game", "file:file-id-1"]);
  });

  it("числовой id канала тоже принимается", async () => {
    const { api, avatar } = adapter();
    expect(await avatar.fetch({ kind: "channel", chat: "-1001234567890" }, signal)).not.toBeNull();
    expect(api.asked[0]).toBe("-1001234567890");
  });

  it("у чата нет фото — null, на страницу не ходим", async () => {
    const api = new FakeBotApi();
    api.photo = null;
    const { avatar, calls } = adapter({}, api);
    expect(await avatar.fetch({ kind: "channel", chat: "@rubezh_game" }, signal)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("файл не картинка или не скачался — null", async () => {
    const api = new FakeBotApi();
    api.file = new TextEncoder().encode("<html>");
    expect(await adapter({}, api).avatar.fetch({ kind: "channel", chat: "@rubezh_game" }, signal)).toBeNull();
    const empty = new FakeBotApi();
    empty.file = null;
    expect(await adapter({}, empty).avatar.fetch({ kind: "channel", chat: "@rubezh_game" }, signal)).toBeNull();
  });

  it("400 или 403 при @имени — бота в канале нет: берём публичную страницу, как у бота", async () => {
    for (const code of [400, 403]) {
      const api = new FakeBotApi();
      api.photoError = new TelegramApiError("getChat", code, "chat not found", null);
      const { avatar, calls } = adapter({ "https://t.me/rubezh_game": page(CDN), [CDN]: new Response(JPEG) }, api);
      expect(await avatar.fetch({ kind: "channel", chat: "@rubezh_game" }, signal), String(code)).toEqual({ bytes: JPEG, contentType: "image/jpeg" });
      expect(calls.map((call) => call.url)).toEqual(["https://t.me/rubezh_game", CDN]);
    }
  });

  it("400 при числовом id — страницы нет, null", async () => {
    const api = new FakeBotApi();
    api.photoError = new TelegramApiError("getChat", 400, "chat not found", null);
    const { avatar, calls } = adapter({}, api);
    expect(await avatar.fetch({ kind: "channel", chat: "-1001234567890" }, signal)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("5xx, лимит и сеть Bot API — SourceAvatarUnavailableError", async () => {
    for (const code of [500, 502, 429, 0]) {
      const api = new FakeBotApi();
      api.photoError = new TelegramApiError("getChat", code, "boom", null);
      await expect(adapter({}, api).avatar.fetch({ kind: "channel", chat: "@rubezh_game" }, signal), String(code)).rejects.toBeInstanceOf(SourceAvatarUnavailableError);
    }
    const download = new FakeBotApi();
    download.fileError = new TelegramApiError("getFile", 502, "boom", null);
    await expect(adapter({}, download).avatar.fetch({ kind: "channel", chat: "@rubezh_game" }, signal)).rejects.toBeInstanceOf(SourceAvatarUnavailableError);
  });

  it("бот не настроен — Bot API не зовём, идём на страницу", async () => {
    const { api, avatar } = adapter({ "https://t.me/rubezh_game": page(CDN), [CDN]: new Response(PNG) }, new FakeBotApi(), false);
    expect(await avatar.fetch({ kind: "channel", chat: "@rubezh_game" }, signal)).toEqual({ bytes: PNG, contentType: "image/png" });
    expect(api.asked).toEqual([]);
  });

  it("канал в чужой записи — SourceAvatarRejectedError", async () => {
    const { avatar } = adapter();
    for (const chat of ["rubezh_game", "@a", "https://t.me/x_chan", "@bad-name", ""]) {
      await expect(avatar.fetch({ kind: "channel", chat }, signal), chat).rejects.toBeInstanceOf(SourceAvatarRejectedError);
    }
  });
});

describe("аватарка бота и Mini App Telegram", () => {
  it("страница с og:image на CDN — байты картинки", async () => {
    const { avatar, calls } = adapter({ "https://t.me/some_bot": page(CDN), [CDN]: new Response(JPEG) });
    expect(await avatar.fetch({ kind: "bot", url: "https://t.me/some_bot?start=rubezh" }, signal)).toEqual({ bytes: JPEG, contentType: "image/jpeg" });
    // Параметры запуска на страницу не уходят; перенаправления не следуем; срок и тип задаёт адаптер.
    expect(calls[0]?.url).toBe("https://t.me/some_bot");
    expect(calls.every((call) => call.init?.redirect === "manual")).toBe(true);
    expect(calls.every((call) => call.init?.signal instanceof AbortSignal)).toBe(true);
  });

  it("Mini App — страница приложения", async () => {
    const { avatar, calls } = adapter({ "https://t.me/some_bot/app": page(CDN), [CDN]: new Response(WEBP) });
    expect(await avatar.fetch({ kind: "bot", url: "https://t.me/some_bot/app?startapp=x" }, signal)).toEqual({ bytes: WEBP, contentType: "image/webp" });
    expect(calls[0]?.url).toBe("https://t.me/some_bot/app");
  });

  it("домен ссылок — из настройки: на страницу идём туда же", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return String(input) === CDN ? new Response(JPEG) : page(CDN);
    }) as typeof fetch;
    const avatar = new TelegramSourceAvatar(new FakeBotApi(), { origin: () => "https://links.example" }, fetchImpl, true);
    expect(await avatar.fetch({ kind: "bot", url: "https://links.example/some_bot" }, signal)).not.toBeNull();
    expect(calls[0]).toBe("https://links.example/some_bot");
  });

  it("og:image на telegram.org — это заглушка «нет картинки»: null, и туда не ходим", async () => {
    const { avatar, calls } = adapter({ "https://t.me/some_bot": page("https://telegram.org/img/t_logo.png") });
    expect(await avatar.fetch({ kind: "bot", url: "https://t.me/some_bot" }, signal)).toBeNull();
    expect(calls.map((call) => call.url)).toEqual(["https://t.me/some_bot"]);
  });

  it("перенаправление страницы и перенаправление картинки — null", async () => {
    const moved = new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
    expect(await adapter({ "https://t.me/some_bot": moved }).avatar.fetch({ kind: "bot", url: "https://t.me/some_bot" }, signal)).toBeNull();
    const redirected = adapter({ "https://t.me/some_bot": page(CDN), [CDN]: new Response(null, { status: 301, headers: { location: "http://169.254.169.254/" } }) });
    expect(await redirected.avatar.fetch({ kind: "bot", url: "https://t.me/some_bot" }, signal)).toBeNull();
  });

  it("картинка 3 МБ — null, и дальше заявленного предела она не читается", async () => {
    let canceled = false;
    const heavy = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      }),
      { headers: { "content-length": String(3 * 1024 * 1024) } },
    );
    const { avatar } = adapter({ "https://t.me/some_bot": page(CDN), [CDN]: heavy });
    expect(await avatar.fetch({ kind: "bot", url: "https://t.me/some_bot" }, signal)).toBeNull();
    expect(canceled).toBe(true);
    const streamed = adapter({ "https://t.me/some_bot": page(CDN), [CDN]: new Response(new Uint8Array(3 * 1024 * 1024)) });
    expect(await streamed.avatar.fetch({ kind: "bot", url: "https://t.me/some_bot" }, signal)).toBeNull();
  });

  it("страница больше 512 КБ — null", async () => {
    const huge = new Response(`<meta property="og:image" content="${CDN}">${" ".repeat(600 * 1024)}`);
    expect(await adapter({ "https://t.me/some_bot": huge }).avatar.fetch({ kind: "bot", url: "https://t.me/some_bot" }, signal)).toBeNull();
  });

  it("байты не картинка — null", async () => {
    const { avatar } = adapter({ "https://t.me/some_bot": page(CDN), [CDN]: new Response("<html>вход</html>") });
    expect(await avatar.fetch({ kind: "bot", url: "https://t.me/some_bot" }, signal)).toBeNull();
  });

  it("страница без og:image или не 200 — null; 5xx и сеть — SourceAvatarUnavailableError", async () => {
    expect(await adapter({ "https://t.me/some_bot": new Response("<html></html>") }).avatar.fetch({ kind: "bot", url: "https://t.me/some_bot" }, signal)).toBeNull();
    expect(await adapter({ "https://t.me/some_bot": new Response("нет", { status: 404 }) }).avatar.fetch({ kind: "bot", url: "https://t.me/some_bot" }, signal)).toBeNull();
    await expect(adapter({ "https://t.me/some_bot": new Response("беда", { status: 503 }) }).avatar.fetch({ kind: "bot", url: "https://t.me/some_bot" }, signal)).rejects.toBeInstanceOf(SourceAvatarUnavailableError);
    await expect(adapter({ "https://t.me/some_bot": new TypeError("fetch failed") }).avatar.fetch({ kind: "bot", url: "https://t.me/some_bot" }, signal)).rejects.toBeInstanceOf(SourceAvatarUnavailableError);
    await expect(adapter({ "https://t.me/some_bot": page(CDN), [CDN]: new TypeError("fetch failed") }).avatar.fetch({ kind: "bot", url: "https://t.me/some_bot" }, signal)).rejects.toBeInstanceOf(SourceAvatarUnavailableError);
  });

  it("ссылка не разобралась — SourceAvatarRejectedError, в сеть не ходим", async () => {
    const { avatar, calls } = adapter();
    for (const url of ["https://evil.example/some_bot", "http://t.me/some_bot", "https://t.me/"]) {
      await expect(avatar.fetch({ kind: "bot", url }, signal), url).rejects.toBeInstanceOf(SourceAvatarRejectedError);
    }
    expect(calls).toEqual([]);
  });
});

describe("порт SourceAvatars", () => {
  it("адаптер по площадке; нет адаптера — null; повторная регистрация заменяет", () => {
    const telegram = new TelegramSourceAvatar(new FakeBotApi(), ORIGIN, fetch, true);
    const avatars = new SourceAvatars([telegram]);
    expect(avatars.for("telegram")).toBe(telegram);
    expect(avatars.for("max")).toBeNull();
    expect(avatars.for("vk")).toBeNull();
    const replacement = new TelegramSourceAvatar(new FakeBotApi(), ORIGIN, fetch, false);
    avatars.register(replacement);
    expect(avatars.for("telegram")).toBe(replacement);
  });
});

describe("Bot API: getChatPhoto и downloadFile", () => {
  const TOKEN = "123456:ABC-test-token";
  const ROOT = "https://api.telegram.test";

  function api(handler: (url: string, init: RequestInit) => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    };
    return { calls, api: new TelegramBotApi(TOKEN, ROOT, fetchImpl) };
  }

  it("getChatPhoto — крупный file_id; у чата нет фото — null", async () => {
    const ok = api(() => new Response(JSON.stringify({ ok: true, result: { id: -100, type: "channel", photo: { small_file_id: "s", big_file_id: "big" } } })));
    expect(await ok.api.getChatPhoto("@rubezh_game")).toBe("big");
    expect(JSON.parse(String(ok.calls[0]?.init.body))).toMatchObject({ chat_id: "@rubezh_game" });
    const none = api(() => new Response(JSON.stringify({ ok: true, result: { id: -100, type: "channel" } })));
    expect(await none.api.getChatPhoto("@rubezh_game")).toBeNull();
  });

  it("getChatPhoto: отказ Telegram — TelegramApiError с кодом", async () => {
    const failing = api(() => new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" }), { status: 400 }));
    await expect(failing.api.getChatPhoto("@nobody_here")).rejects.toMatchObject({ errorCode: 400 });
  });

  it("downloadFile: getFile, затем файл по адресу с токеном; байты как есть", async () => {
    const files = api((url) => (url.endsWith("/getFile") ? new Response(JSON.stringify({ ok: true, result: { file_id: "big", file_path: "photos/file_1.jpg" } })) : new Response(JPEG)));
    expect(await files.api.downloadFile("big", 1024, signal)).toEqual(JPEG);
    expect(files.calls[1]?.url).toBe(`${ROOT}/file/bot${TOKEN}/photos/file_1.jpg`);
  });

  it("downloadFile: файл больше предела — null; нет file_path — null; не 200 — TelegramApiError без токена в тексте", async () => {
    const heavy = api((url) => (url.endsWith("/getFile") ? new Response(JSON.stringify({ ok: true, result: { file_id: "big", file_path: "p.jpg" } })) : new Response(new Uint8Array(100))));
    expect(await heavy.api.downloadFile("big", 10, signal)).toBeNull();
    const noPath = api(() => new Response(JSON.stringify({ ok: true, result: { file_id: "big" } })));
    expect(await noPath.api.downloadFile("big", 10, signal)).toBeNull();
    const broken = api((url) => (url.endsWith("/getFile") ? new Response(JSON.stringify({ ok: true, result: { file_id: "big", file_path: "p.jpg" } })) : new Response("нет", { status: 502 })));
    const error = await broken.api.downloadFile("big", 1024, signal).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error).toMatchObject({ errorCode: 502 });
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });

  it("downloadFile: сбой сети не выносит токен в текст ошибки", async () => {
    const calls = new TelegramBotApi(TOKEN, ROOT, async (url) => {
      if (url.endsWith("/getFile")) return new Response(JSON.stringify({ ok: true, result: { file_id: "big", file_path: "p.jpg" } }));
      throw new TypeError(`fetch failed: ${url}`);
    });
    const error = await calls.downloadFile("big", 1024, signal).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ errorCode: 0 });
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });
});
