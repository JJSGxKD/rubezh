import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { loadAppConfig } from "../src/config/app-config.js";
import { BotPoller, type BotPollerLocks, type PollerBotApi } from "../src/platforms/telegram/bot-poller.js";
import { BotRouter, type BotUpdateHandler } from "../src/platforms/telegram/bot-router.js";
import type { BotUpdateQueue } from "../src/platforms/telegram/bot-update-queue.js";
import { TelegramApiError, TelegramBotApi, type TelegramUpdate } from "../src/platforms/telegram/telegram-bot-api.js";
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

  it("сообщает исход: взял обработчик — handled с его именем", async () => {
    const router = new BotRouter();
    router.register(recordingHandler("stats", (incoming) => incoming.message?.text === "/stats"));
    router.register(recordingHandler("start", () => true));

    await expect(router.dispatch(update(1, "/stats"))).resolves.toEqual({ status: "handled", handler: "stats" });
    await expect(router.dispatch(update(2, "/start"))).resolves.toEqual({ status: "handled", handler: "start" });
  });

  it("никто не взял — unhandled", async () => {
    const router = new BotRouter();
    router.register(recordingHandler("stats", () => false));

    await expect(router.dispatch(update(1))).resolves.toEqual({ status: "unhandled" });
    await expect(new BotRouter().dispatch(update(2))).resolves.toEqual({ status: "unhandled" });
  });

  it("упавший обработчик не роняет чтение обновлений: failed с его именем, в логе handler_failed", async () => {
    const router = new BotRouter();
    router.register({ name: "broken", handle: async () => Promise.reject(new Error("сломался")) });
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      await expect(router.dispatch(update(3))).resolves.toEqual({ status: "failed", handler: "broken" });
      expect(error.mock.calls.some(([line]) => String(line).includes("handler_failed") && String(line).includes('"handler":"broken"'))).toBe(true);
    } finally {
      error.mockRestore();
    }
  });
});

describe("обработчик по умолчанию", () => {
  it("получает обновление, только если его не взял ни один обработчик", async () => {
    const router = new BotRouter();
    const taken = recordingHandler("taken", (incoming) => incoming.update_id === 1);
    const fallback = recordingHandler("fallback", () => true);
    router.register(taken);
    router.setFallback(fallback);

    await expect(router.dispatch(update(1))).resolves.toEqual({ status: "handled", handler: "taken" });
    await expect(router.dispatch(update(2))).resolves.toEqual({ status: "handled", handler: "fallback" });

    expect(taken.seen).toEqual([1, 2]);
    expect(fallback.seen).toEqual([2]);
  });

  it("не взял и обработчик по умолчанию — unhandled", async () => {
    const router = new BotRouter();
    router.setFallback(recordingHandler("fallback", () => false));

    await expect(router.dispatch(update(1))).resolves.toEqual({ status: "unhandled" });
  });

  it("не мешает порядку регистрации: заданный раньше обработчиков, он всё равно последний", async () => {
    const router = new BotRouter();
    const fallback = recordingHandler("fallback", () => true);
    router.setFallback(fallback);
    router.register(recordingHandler("late", () => true));

    await router.dispatch(update(3));

    expect(fallback.seen).toEqual([]);
  });

  it("упавший обработчик останавливает разбор: по умолчанию не вызывается, в логе handler_failed", async () => {
    const router = new BotRouter();
    const fallback = recordingHandler("fallback", () => true);
    router.register({ name: "broken", handle: async () => Promise.reject(new Error("сломался")) });
    router.setFallback(fallback);
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      await expect(router.dispatch(update(4))).resolves.toEqual({ status: "failed", handler: "broken" });
      expect(fallback.seen).toEqual([]);
      expect(error.mock.calls.some(([line]) => String(line).includes("handler_failed"))).toBe(true);
    } finally {
      error.mockRestore();
    }
  });

  it("упавший обработчик по умолчанию логируется так же и не роняет разбор", async () => {
    const router = new BotRouter();
    router.setFallback({ name: "fallback", handle: async () => Promise.reject(new Error("сломался")) });
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      await expect(router.dispatch(update(5))).resolves.toEqual({ status: "failed", handler: "fallback" });
      expect(error.mock.calls.some(([line]) => String(line).includes('"handler":"fallback"'))).toBe(true);
    } finally {
      error.mockRestore();
    }
  });

  it("второй раз задать нельзя", () => {
    const router = new BotRouter();
    router.setFallback(recordingHandler("one", () => true));
    expect(() => router.setFallback(recordingHandler("two", () => true))).toThrow("Обработчик по умолчанию уже задан");
  });

  it("в список команд не попадает", () => {
    const router = new BotRouter();
    router.setFallback({ name: "fallback", commands: [{ command: "x", description: "x", audience: "everyone" }], handle: async () => true });
    expect(router.commands()).toEqual([]);
  });
});

describe("чтение обновлений long polling'ом", () => {
  const cfg = loadAppConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_BOT_UPDATES: "polling" });

  /** Очередь обновлений и замки пишут общий журнал: порядок «в очередь, потом смещение» виден в нём. */
  function setup(): {
    poller: BotPoller;
    locks: MemoryPollerLocks;
    api: PollerBotApi & { pending: TelegramUpdate[] };
    journal: string[];
    updates: Pick<BotUpdateQueue, "enqueue"> & { failOn: number | null };
  } {
    const journal: string[] = [];
    const locks = new MemoryPollerLocks();
    const saveOffset = locks.saveOffset.bind(locks);
    locks.saveOffset = async (offset: number) => {
      journal.push(`offset:${String(offset)}`);
      await saveOffset(offset);
    };
    const api = {
      pending: [] as TelegramUpdate[],
      async getUpdates() {
        const updates = api.pending.splice(0);
        return { updates, lastUpdateId: updates.at(-1)?.update_id ?? null };
      },
    };
    const updates = {
      failOn: null as number | null,
      async enqueue(incoming: TelegramUpdate) {
        if (incoming.update_id === updates.failOn) throw new Error("очередь недоступна");
        journal.push(`enqueue:${String(incoming.update_id)}`);
      },
    };
    return { poller: new BotPoller(cfg, updates as unknown as BotUpdateQueue, locks, api), locks, api, journal, updates };
  }

  it("кладёт каждое обновление в очередь и только после всей пачки сдвигает смещение", async () => {
    const { poller, locks, api, journal } = setup();
    api.pending = [update(41), update(42)];
    await poller.pollOnce();
    expect(journal).toEqual(["enqueue:41", "enqueue:42", "offset:43"]);
    expect(locks.offset).toBe(43);
  });

  it("очередь не приняла второе обновление — смещение не сдвигается: ту же пачку заберёт следующий проход", async () => {
    const { poller, locks, api, journal, updates } = setup();
    api.pending = [update(41), update(42)];
    updates.failOn = 42;

    await expect(poller.pollOnce()).rejects.toThrow("очередь недоступна");

    expect(journal).toEqual(["enqueue:41"]);
    expect(locks.offset).toBeNull();
  });

  it("пустая пачка ничего не ставит и смещение не трогает", async () => {
    const { poller, locks, journal } = setup();

    await poller.pollOnce();

    expect(journal).toEqual([]);
    expect(locks.offset).toBeNull();
  });

  it("не читает обновления, пока роль читателя у другого процесса", async () => {
    const { poller, locks, api, journal } = setup();
    locks.poller = "another-process";
    api.pending = [update(5)];
    const waiting = poller.pollOnce();
    await poller.onModuleDestroy();
    await waiting;
    expect(journal).toEqual([]);
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

  it("готовит сообщение для shareMessage: статья с кнопкой, в личку, группы и каналы, не в чаты ботов", async () => {
    const { calls, api } = recorder({ ok: true, result: { id: "abc", expiration_date: 1_790_000_000 } });
    const prepared = await api.savePreparedInlineMessage(424242, {
      id: "invite-1",
      title: "Играть вместе",
      description: "Откроешь — и мы друзья",
      text: "Зову тебя в игру",
      button: { text: "▶ Играть", url: "https://t.me/bot/play?startapp=f-x" },
    });

    expect(prepared).toEqual({ id: "abc", expiresAt: new Date(1_790_000_000_000) });
    expect(calls[0]?.url).toContain("/savePreparedInlineMessage");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      user_id: 424242,
      result: {
        type: "article",
        id: "invite-1",
        input_message_content: { message_text: "Зову тебя в игру" },
        reply_markup: { inline_keyboard: [[{ text: "▶ Играть", url: "https://t.me/bot/play?startapp=f-x" }]] },
      },
      allow_user_chats: true,
      allow_group_chats: true,
      allow_channel_chats: true,
      allow_bot_chats: false,
    });
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
