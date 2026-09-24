import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { BotPoller, type BotPollerLocks, type PollerBotApi } from "../src/modules/bot/bot-poller.js";
import { BotRouter, type BotUpdateHandler } from "../src/modules/bot/bot-router.js";
import { TelegramApiError, TelegramBotApi, type TelegramUpdate } from "../src/modules/telegram/telegram-bot-api.js";
import { multipartOf } from "./helpers/multipart.js";

// Бот: откуда приходят обновления, куда уходят и как говорить с Bot API
// (docs/28-diagnostics.md §6.1).

const TOKEN = "123456:SECRET-token";
const CLOUD_API = "https://api.telegram.org";
const CHAT = "-1001234567890";

function update(id: number, text = "/start"): TelegramUpdate {
  return { update_id: id, message: { message_id: id, date: 1, text, chat: { id: 1, type: "private" }, from: { id: 1, is_bot: false } } };
}

class MemoryPollerLocks implements BotPollerLocks {
  poller: string | null = null;
  offset: number | null = null;
  async holdPoller(ownerId: string): Promise<boolean> {
    if (this.poller !== null && this.poller !== ownerId) return false;
    this.poller = ownerId;
    return true;
  }
  async releasePoller(ownerId: string): Promise<void> {
    if (this.poller === ownerId) this.poller = null;
  }
  async readOffset(): Promise<number | null> {
    return this.offset;
  }
  async saveOffset(offset: number): Promise<void> {
    this.offset = offset;
  }
}

function recordingHandler(name: string, claims: (update: TelegramUpdate) => boolean): BotUpdateHandler & { seen: number[] } {
  const handler = {
    name,
    seen: [] as number[],
    async handle(incoming: TelegramUpdate) {
      handler.seen.push(incoming.update_id);
      return claims(incoming);
    },
  };
  return handler;
}

describe("маршрутизатор обновлений", () => {
  it("отдаёт обновление первому обработчику, который его взял", async () => {
    const router = new BotRouter();
    const stats = recordingHandler("stats", (incoming) => incoming.message?.text === "/stats");
    const start = recordingHandler("start", () => true);
    router.register(stats);
    router.register(start);

    await router.dispatch(update(1, "/stats"));
    await router.dispatch(update(2, "/start"));
    expect(stats.seen).toEqual([1, 2]);
    expect(start.seen).toEqual([2]);
  });

  it("упавший обработчик не роняет чтение обновлений", async () => {
    const router = new BotRouter();
    router.register({ name: "broken", handle: async () => Promise.reject(new Error("сломался")) });
    await expect(router.dispatch(update(3))).resolves.toBeUndefined();
  });
});

describe("чтение обновлений long polling'ом", () => {
  const cfg = loadAppConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_BOT_UPDATES: "polling" });

  function setup(): { poller: BotPoller; locks: MemoryPollerLocks; api: PollerBotApi & { pending: TelegramUpdate[] }; handler: ReturnType<typeof recordingHandler> } {
    const locks = new MemoryPollerLocks();
    const api = {
      pending: [] as TelegramUpdate[],
      async getUpdates() {
        const updates = api.pending.splice(0);
        return { updates, lastUpdateId: updates.at(-1)?.update_id ?? null };
      },
    };
    const router = new BotRouter();
    const handler = recordingHandler("all", () => true);
    router.register(handler);
    return { poller: new BotPoller(cfg, router, locks, api), locks, api, handler };
  }

  it("передаёт обновления маршрутизатору и сдвигает смещение", async () => {
    const { poller, locks, api, handler } = setup();
    api.pending = [update(41), update(42)];
    await poller.pollOnce();
    expect(handler.seen).toEqual([41, 42]);
    expect(locks.offset).toBe(43);
  });

  it("не читает обновления, пока роль читателя у другого процесса", async () => {
    const { poller, locks, api, handler } = setup();
    locks.poller = "another-process";
    api.pending = [update(5)];
    const waiting = poller.pollOnce();
    await poller.onModuleDestroy();
    await waiting;
    expect(handler.seen).toEqual([]);
  });

  it("не запускается, пока чтение обновлений выключено", () => {
    const off = loadAppConfig({ TELEGRAM_BOT_TOKEN: TOKEN });
    expect(off.telegram.updates).toBe("off");
    expect(() => loadAppConfig({ TELEGRAM_BOT_UPDATES: "polling" })).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});

describe("клиент Bot API", () => {
  function recorder(reply: unknown, status = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(reply), { status });
    };
    return { calls, api: new TelegramBotApi(TOKEN, CLOUD_API, fetchImpl) };
  }

  it("пропускает нераспознанные обновления, но сдвигает смещение за них", async () => {
    const { calls, api } = recorder({
      ok: true,
      result: [
        { update_id: 7, message: { message_id: 1, date: 1, text: "/stats", chat: { id: 1, type: "private" }, from: { id: 1, is_bot: false } } },
        { update_id: 8, message: { weird: true } },
      ],
    });
    const result = await api.getUpdates(7, 25);
    expect(result.updates.map((incoming) => incoming.update_id)).toEqual([7]);
    expect(result.lastUpdateId).toBe(8);
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ offset: 7, timeout: 25 });
  });

  it("отправляет фото формой, а ошибку Telegram разбирает с retry_after", async () => {
    const ok = recorder({ ok: true, result: { message_id: 1 } });
    await ok.api.sendPhoto(CHAT, Buffer.from("png"), "подпись");
    const form = await multipartOf(ok.calls[0]?.init ?? {});
    expect(form.get("chat_id")).toBe(CHAT);
    expect(form.get("caption")).toBe("подпись");
    expect(await (form.get("photo") as File).text()).toBe("png");

    const limited = recorder({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 12 } }, 429);
    await expect(limited.api.sendMessage(CHAT, "x")).rejects.toMatchObject({ errorCode: 429, retryAfterSec: 12 });
  });

  it("обрывает зависший запрос по сигналу: срок задаёт вызов, а не транспорт", async () => {
    // Сигнал проходит через grammY до нашего fetch — иначе долгий опрос или
    // остановка процесса ждали бы ответа Telegram без срока.
    const api = new TelegramBotApi(TOKEN, CLOUD_API, (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    );
    const stop = new AbortController();
    const pending = api.sendMessage(CHAT, "x", stop.signal).catch((caught: unknown) => caught);
    stop.abort();

    expect(await pending).toMatchObject({ errorCode: 0 });
  });

  it("не выносит токен бота в текст ошибки сети", async () => {
    const api = new TelegramBotApi(TOKEN, CLOUD_API, async (url) => {
      throw new TypeError(`fetch failed: ${url}`);
    });
    const error = await api.sendMessage(CHAT, "x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });
});
