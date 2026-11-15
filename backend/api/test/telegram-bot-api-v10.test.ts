import { afterEach, describe, expect, it, vi } from "vitest";
import { ALLOWED_UPDATES, TelegramApiError, TelegramBotApi, updateSchema, type FetchLike } from "../src/platforms/telegram/telegram-bot-api.js";

/**
 * Слой Bot API 10.x (tasks/T-0393): оформленные и эфемерные сообщения, темы и
 * виджеты. Сеть — подменённый `fetch`, который записывает адрес и разобранное
 * тело; настоящий Bot API не вызывается.
 */

const TOKEN = "123456:SECRET-TEST-TOKEN";
const API_ROOT = "https://api.telegram.org";

interface Call {
  url: string;
  body: Record<string, unknown>;
  signal: AbortSignal | null | undefined;
}

function recorder(reply: unknown, status = 200) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const text = typeof init.body === "string" ? init.body : "{}";
    calls.push({ url, body: JSON.parse(text) as Record<string, unknown>, signal: init.signal });
    return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), { status });
  };
  return { calls, api: new TelegramBotApi(TOKEN, API_ROOT, fetchImpl) };
}

function failing(error: unknown) {
  let called = 0;
  const api = new TelegramBotApi(TOKEN, API_ROOT, async () => {
    called += 1;
    throw error;
  });
  return { api, called: () => called };
}

const ok = (result: unknown) => ({ ok: true, result });
const rich = { blocks: [{ type: "paragraph", text: "Итог забега" }] } as never;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("оформленные сообщения", () => {
  it("sendRichMessage несёт клавиатуру, тишину и тему", async () => {
    const { calls, api } = recorder(ok({ message_id: 42, date: 1, chat: { id: 5, type: "private" } }));
    const id = await api.rich.sendRichMessage(
      { chatId: "5", threadId: 7 },
      rich,
      { keyboard: [[{ text: "Играть", callback_data: "play" }]], silent: true },
    );

    expect(id).toBe(42);
    expect(calls[0]?.url).toBe(`${API_ROOT}/bot${TOKEN}/sendRichMessage`);
    expect(calls[0]?.body).toMatchObject({
      chat_id: "5",
      rich_message: { blocks: [{ type: "paragraph", text: "Итог забега" }] },
      reply_markup: { inline_keyboard: [[{ text: "Играть", callback_data: "play" }]] },
      disable_notification: true,
      message_thread_id: 7,
    });
  });

  it("sendRichMessage без настроек не шлёт лишних полей", async () => {
    const { calls, api } = recorder(ok({ message_id: 1 }));
    await api.rich.sendRichMessage("5", rich);
    expect(Object.keys(calls[0]?.body ?? {}).sort()).toEqual(["chat_id", "rich_message"]);
  });

  it("sendRichMessage умеет эфемерный ответ на нажатие", async () => {
    const { calls, api } = recorder(ok({ message_id: 1 }));
    await api.rich.sendRichMessage("-100", rich, { ephemeral: { receiverUserId: 5, callbackQueryId: "q1", replaceOriginal: true } });
    expect(calls[0]?.body.ephemeral_message_parameters).toEqual({ receiver_user_id: 5, callback_query_id: "q1", replace_callback_query_message: true });
  });

  it("editRichMessage вызывает editMessageText с rich_message и без text", async () => {
    const { calls, api } = recorder(ok(true));
    await api.rich.editRichMessage({ chatId: "5", threadId: null }, 9, rich);

    expect(calls[0]?.url).toBe(`${API_ROOT}/bot${TOKEN}/editMessageText`);
    expect(calls[0]?.body).toMatchObject({ chat_id: "5", message_id: 9, rich_message: { blocks: [{ type: "paragraph", text: "Итог забега" }] } });
    expect(calls[0]?.body).not.toHaveProperty("text");
  });

  it("ответ Telegram не по схеме — ошибка, а не неопределённый id", async () => {
    const { api } = recorder(ok({ nothing: true }));
    await expect(api.rich.sendRichMessage("5", rich)).rejects.toThrow();
  });
});

describe("эфемерные сообщения", () => {
  it("sendMessage передаёт ephemeral_message_parameters, а без ephemeral поля нет", async () => {
    const withEphemeral = recorder(ok({ message_id: 1 }));
    await withEphemeral.api.sendMessage("-100", "Только тебе", undefined, { ephemeral: { receiverUserId: 5, callbackQueryId: "q1" } });
    expect(withEphemeral.calls[0]?.body.ephemeral_message_parameters).toEqual({ receiver_user_id: 5, callback_query_id: "q1" });

    const plain = recorder(ok({ message_id: 1 }));
    await plain.api.sendMessage("-100", "Всем");
    expect(plain.calls[0]?.body).not.toHaveProperty("ephemeral_message_parameters");
    expect(plain.calls[0]?.body).not.toHaveProperty("disable_notification");
  });

  it("sendMessage поддерживает тихую отправку", async () => {
    const { calls, api } = recorder(ok({ message_id: 1 }));
    await api.sendMessage("5", "Тихо", undefined, { silent: true });
    expect(calls[0]?.body.disable_notification).toBe(true);
  });
});

describe("темы", () => {
  it("createForumTopic создаёт тему и отдаёт её номер", async () => {
    const { calls, api } = recorder(ok({ message_thread_id: 77, name: "Новости", icon_color: 7322096 }));
    const topic = await api.rich.createForumTopic(5, "Новости", 0x6fb9f0);

    expect(topic).toEqual({ threadId: 77 });
    expect(calls[0]?.url).toBe(`${API_ROOT}/bot${TOKEN}/createForumTopic`);
    expect(calls[0]?.body).toEqual({ chat_id: 5, name: "Новости", icon_color: 7322096 });
  });

  it("имя темы длиннее 128 знаков — RangeError без сети", async () => {
    const { calls, api } = recorder(ok({ message_thread_id: 1 }));
    await expect(api.rich.createForumTopic(5, "я".repeat(129), 0x6fb9f0)).rejects.toThrow(RangeError);
    await expect(api.rich.createForumTopic(5, "", 0x6fb9f0)).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("getMe отдаёт, включены ли темы в личке", async () => {
    const on = recorder(ok({ id: 1, is_bot: true, username: "rubezh_bot", has_topics_enabled: true }));
    expect(await on.api.getMe()).toEqual({ id: 1, username: "rubezh_bot", topicsEnabled: true });

    const off = recorder(ok({ id: 1, is_bot: true, username: "rubezh_bot" }));
    expect((await off.api.getMe()).topicsEnabled).toBe(false);
  });
});

describe("виджеты: sendWidget", () => {
  it("шлёт на sendWidget поля Bot API и пропускает неопределённые", async () => {
    const { calls, api } = recorder(ok({ message_id: 11 }));
    const sent = await api.widgets.sendWidget("-100", {
      html: "<div>карточка</div>",
      allowQueries: true,
      protect: true,
      chatData: "state-1",
      keyboard: [[{ text: "Играть", url: "https://t.me/bot/play" }]],
      width: undefined,
      caption: undefined,
    });

    expect(sent).toEqual({ messageId: 11, widgetId: null });
    expect(calls[0]?.url).toBe(`${API_ROOT}/bot${TOKEN}/sendWidget`);
    expect(calls[0]?.body).toEqual({
      chat_id: "-100",
      html: "<div>карточка</div>",
      allow_queries: true,
      protect_content: true,
      chat_data: "state-1",
      reply_markup: { inline_keyboard: [[{ text: "Играть", url: "https://t.me/bot/play" }]] },
    });
  });

  it("передаёт тему, тишину, размеры и данные", async () => {
    const { calls, api } = recorder(ok({ message_id: 1 }));
    await api.widgets.sendWidget("-100", { html: "<b>x</b>", threadId: 4, silent: true, width: 300, height: 200, publicData: "p", caption: "подпись", isShared: true });
    expect(calls[0]?.body).toMatchObject({ message_thread_id: 4, disable_notification: true, width: 300, height: 200, public_data: "p", caption: "подпись", is_shared: true });
  });

  it("html из 32 769 байт и chat_data из 1025 байт — RangeError, сеть не тронута", async () => {
    const { calls, api } = recorder(ok({ message_id: 1 }));
    await expect(api.widgets.sendWidget("5", { html: "a".repeat(32_769) })).rejects.toThrow(RangeError);
    await expect(api.widgets.sendWidget("5", { html: "<b>x</b>", chatData: "a".repeat(1025) })).rejects.toThrow(RangeError);
    await expect(api.widgets.sendWidget("5", { html: "<b>x</b>", publicData: "a".repeat(1025) })).rejects.toThrow(RangeError);
    await expect(api.widgets.sendWidget("5", { html: "" })).rejects.toThrow(RangeError);
    await expect(api.widgets.sendWidget("5", { html: "<b>x</b>", caption: "a".repeat(1025) })).rejects.toThrow(RangeError);
    await expect(api.widgets.sendWidget("5", { html: "<b>x</b>", height: 49 })).rejects.toThrow(RangeError);
    await expect(api.widgets.sendWidget("5", { html: "<b>x</b>", height: 601 })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("границы по байтам, а не по знакам: кириллица занимает по два", async () => {
    const { calls, api } = recorder(ok({ message_id: 1 }));
    await expect(api.widgets.sendWidget("5", { html: "<b>x</b>", chatData: "я".repeat(513) })).rejects.toThrow(RangeError);
    await api.widgets.sendWidget("5", { html: "<b>x</b>", chatData: "я".repeat(512) });
    expect(calls).toHaveLength(1);
  });

  it("у общего виджета возвращает его id", async () => {
    const withId = recorder(ok({ message_id: 3, widget: { id: "w1" } }));
    expect(await withId.api.widgets.sendWidget("5", { html: "<b>x</b>", isShared: true })).toEqual({ messageId: 3, widgetId: "w1" });

    const without = recorder(ok({ message_id: 3 }));
    expect((await without.api.widgets.sendWidget("5", { html: "<b>x</b>" })).widgetId).toBeNull();
  });
});

describe("виджеты: остальные методы", () => {
  it("sendSharedWidget шлёт widget_id и опции", async () => {
    const { calls, api } = recorder(ok({ message_id: 8 }));
    const sent = await api.widgets.sendSharedWidget("-100", "w1", { chatData: "c", caption: "подпись", silent: true, threadId: 2 });

    expect(sent).toEqual({ messageId: 8 });
    expect(calls[0]?.url).toBe(`${API_ROOT}/bot${TOKEN}/sendSharedWidget`);
    expect(calls[0]?.body).toEqual({ chat_id: "-100", widget_id: "w1", chat_data: "c", caption: "подпись", disable_notification: true, message_thread_id: 2 });
  });

  it("editMessageWidgetData: ok — edited", async () => {
    const { calls, api } = recorder(ok(true));
    expect(await api.widgets.editMessageWidgetData("5", 9, { publicData: "p" })).toBe("edited");
    expect(calls[0]?.url).toBe(`${API_ROOT}/bot${TOKEN}/editMessageWidgetData`);
    expect(calls[0]?.body).toEqual({ chat_id: "5", message_id: 9, public_data: "p" });
  });

  it("editMessageWidgetData: «message is not modified» — unchanged, а не ошибка", async () => {
    const { api } = recorder({ ok: false, error_code: 400, description: "Bad Request: message is not modified" }, 400);
    expect(await api.widgets.editMessageWidgetData("5", 9, { chatData: "c" })).toBe("unchanged");

    const upper = recorder({ ok: false, error_code: 400, description: "Bad Request: MESSAGE IS NOT MODIFIED: exactly the same" }, 400);
    expect(await upper.api.widgets.editMessageWidgetData("5", 9, { chatData: "c" })).toBe("unchanged");
  });

  it("editMessageWidgetData: другой 400 — TelegramApiError", async () => {
    const { api } = recorder({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" }, 400);
    const error = await api.widgets.editMessageWidgetData("5", 9, { chatData: "c" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error).toMatchObject({ errorCode: 400 });
  });

  it("editSharedWidgetData: cache_time вне 5–3600 — RangeError, 300 уходит в тело", async () => {
    const { calls, api } = recorder(ok(true));
    await expect(api.widgets.editSharedWidgetData("w1", "p", 4)).rejects.toThrow(RangeError);
    await expect(api.widgets.editSharedWidgetData("w1", "p", 3601)).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);

    await api.widgets.editSharedWidgetData("w1", "p", 300);
    expect(calls[0]?.url).toBe(`${API_ROOT}/bot${TOKEN}/editSharedWidgetData`);
    expect(calls[0]?.body).toEqual({ widget_id: "w1", public_data: "p", cache_time: 300 });

    await api.widgets.editSharedWidgetData("w1", "p");
    expect(calls[1]?.body).not.toHaveProperty("cache_time");
  });

  it("answerWidgetQuery: data из 1025 байт — RangeError, сеть не тронута", async () => {
    const { calls, api } = recorder(ok(true));
    await expect(api.widgets.answerWidgetQuery("q1", "a".repeat(1025))).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);

    await api.widgets.answerWidgetQuery("q1", "ответ");
    expect(calls[0]?.url).toBe(`${API_ROOT}/bot${TOKEN}/answerWidgetQuery`);
    expect(calls[0]?.body).toEqual({ widget_query_id: "q1", data: "ответ" });
  });

  it("answerWidgetQuery ждёт не дольше 5 секунд и отменяется по сигналу", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const api = new TelegramBotApi(
      TOKEN,
      API_ROOT,
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const stop = new AbortController();
    const pending = api.widgets.answerWidgetQuery("q1", undefined, stop.signal).catch((caught: unknown) => caught);
    stop.abort();

    expect(timeout).toHaveBeenCalledWith(5_000);
    expect(await pending).toMatchObject({ errorCode: 0 });
  });
});

describe("ошибки сырого вызова", () => {
  it("429 с retry_after — TelegramApiError с паузой", async () => {
    const { api } = recorder({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } }, 429);
    const error = await api.widgets.sendWidget("5", { html: "<b>x</b>" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error).toMatchObject({ method: "sendWidget", errorCode: 429, retryAfterSec: 3 });
  });

  it("сбой сети не выносит токен и адрес в текст ошибки", async () => {
    const { api } = failing(new TypeError("fetch failed", { cause: new Error(`connect ECONNREFUSED ${API_ROOT}/bot${TOKEN}/sendWidget`) }));
    const error = await api.widgets.sendWidget("5", { html: "<b>x</b>" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error).toMatchObject({ errorCode: 0 });
    const text = String((error as Error).message);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("api.telegram.org");
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it("тело не JSON — код 0", async () => {
    const { api } = recorder("<html>502 Bad Gateway</html>", 502);
    const error = await api.widgets.answerWidgetQuery("q1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error).toMatchObject({ errorCode: 0 });
  });

  it("ответ не по схеме — код 0, а не неопределённый результат", async () => {
    const { api } = recorder({ ok: true, result: { message_id: "not a number" } });
    const error = await api.widgets.sendWidget("5", { html: "<b>x</b>" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ errorCode: 0 });
  });

  it("ошибка grammY в оформленных сообщениях тоже без токена", async () => {
    const { api } = failing(new TypeError(`fetch failed: ${API_ROOT}/bot${TOKEN}/sendRichMessage`));
    const error = await api.rich.sendRichMessage("5", rich).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });
});

describe("входящие запросы виджетов", () => {
  const from = { id: 7, is_bot: false };

  it("widget_query разбирается, а незнакомые поля не роняют разбор", () => {
    const parsed = updateSchema.safeParse({
      update_id: 1,
      foo: "новое поле верхнего уровня",
      widget_query: {
        id: "wq-1",
        from,
        chat_instance: "ci-1",
        type: { type: "data", wallet_card: { anything: 1 } },
        data: "open",
        widget_id: "w1",
        unknown_field: true,
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.widget_query).toMatchObject({ id: "wq-1", data: "open", widget_id: "w1" });
  });

  it("data из 65 байт (кириллица — 33 знака) не проходит, 64 байта — проходят", () => {
    const base = { id: "wq-1", from, chat_instance: "ci-1", type: { type: "data" } };
    expect(updateSchema.safeParse({ update_id: 1, widget_query: { ...base, data: "я".repeat(33) } }).success).toBe(false);
    expect(updateSchema.safeParse({ update_id: 1, widget_query: { ...base, data: "я".repeat(32) } }).success).toBe(true);
    expect(updateSchema.safeParse({ update_id: 1, widget_query: { ...base, data: "" } }).success).toBe(false);
  });

  it("shared_widget_query без widget_id не проходит", () => {
    const query = { id: "sq-1", from, type: { type: "data" }, data: "open" };
    expect(updateSchema.safeParse({ update_id: 1, shared_widget_query: query }).success).toBe(false);
    expect(updateSchema.safeParse({ update_id: 1, shared_widget_query: { ...query, widget_id: "w1" } }).success).toBe(true);
  });

  it("shared_widget_query: data тоже до 64 байт", () => {
    const query = { id: "sq-1", from, type: { type: "data" }, widget_id: "w1", data: "я".repeat(33) };
    expect(updateSchema.safeParse({ update_id: 1, shared_widget_query: query }).success).toBe(false);
  });

  it("обновления просят у Telegram вместе с остальными", () => {
    expect(ALLOWED_UPDATES).toContain("widget_query");
    expect(ALLOWED_UPDATES).toContain("shared_widget_query");
  });
});
