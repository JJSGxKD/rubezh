import { describe, expect, it } from "vitest";
import type { OutgoingMessage } from "../src/platforms/ports/messenger.js";
import { plainTextOf, type RichDocument } from "../src/platforms/ports/rich-message.js";
import { TelegramApiError } from "../src/platforms/telegram/telegram-bot-api.js";
import { RICH_RETRY_MS, TelegramMessenger, type MessengerBotApi } from "../src/platforms/telegram/telegram-messenger.js";
import { toTelegramRich } from "../src/platforms/telegram/telegram-rich-render.js";

/**
 * Оформленное сообщение через бота Telegram (tasks/T-0394, Р199, Р225):
 * отправка методом `sendRichMessage`, запасной простой текст при отказе и
 * пауза в 30 минут, пока метод недоступен.
 */

const DOCUMENT: RichDocument = { blocks: [{ kind: "heading", text: "Итоги" }, { kind: "paragraph", text: "Ты четвёртый" }] };
const RICH: OutgoingMessage = {
  text: plainTextOf(DOCUMENT),
  rich: DOCUMENT,
  button: { text: "▶ Играть", url: "https://t.me/rubezh_bot/play" },
  action: { text: "🔕 Не напоминать", data: "rm:off" },
};
const KEYBOARD = [[{ text: "▶ Играть", url: "https://t.me/rubezh_bot/play" }], [{ text: "🔕 Не напоминать", callback_data: "rm:off" }]];

type Failure = Error | null;

function setup(richFailure: () => Failure = () => null, plainFailure: () => Failure = () => null) {
  const rich: unknown[][] = [];
  const plain: unknown[][] = [];
  const logs: Record<string, unknown>[] = [];
  let clock = 1_000_000;
  const api: MessengerBotApi = {
    sendMessage: async (...args: unknown[]) => {
      plain.push(args);
      const failure = plainFailure();
      if (failure !== null) throw failure;
      return 1;
    },
    rich: {
      sendRichMessage: async (...args: unknown[]) => {
        rich.push(args);
        const failure = richFailure();
        if (failure !== null) throw failure;
        return 2;
      },
    } as unknown as NonNullable<MessengerBotApi["rich"]>,
  };
  const messenger = new TelegramMessenger(api, true, { now: () => clock, warn: (line) => logs.push(line) });
  return { messenger, rich, plain, logs, advance: (ms: number) => void (clock += ms) };
}

const refusal = (code: number, description = "Bad Request: BLOCK_INVALID") => new TelegramApiError("sendRichMessage", code, description, null);

describe("оформленное сообщение в Telegram", () => {
  it("с rich зовётся sendRichMessage: тело из документа, клавиатура из button и action, silent", async () => {
    const s = setup();
    expect(await s.messenger.send("123456", { ...RICH, silent: true })).toEqual({ status: "sent" });
    expect(s.plain).toEqual([]);
    expect(s.rich).toEqual([["123456", toTelegramRich(DOCUMENT), { keyboard: KEYBOARD, silent: true }]]);
  });

  it("без silent и без кнопок поле не передаётся", async () => {
    const s = setup();
    await s.messenger.send("123456", { text: RICH.text, rich: DOCUMENT, button: null });
    expect(s.rich[0]?.[2]).toEqual({});
  });

  it("без rich — обычный sendMessage, silent передаётся", async () => {
    const s = setup();
    expect(await s.messenger.send("123456", { text: "Привет", button: RICH.button, silent: true })).toEqual({ status: "sent" });
    expect(s.rich).toEqual([]);
    expect(s.plain).toEqual([["123456", "Привет", undefined, { keyboard: [KEYBOARD[0]], silent: true }]]);
  });

  it("возможности порта: оформление есть, тем нет", () => {
    expect(setup().messenger.capabilities).toEqual({ rich: true, topics: false });
  });

  it("400 BLOCK_INVALID — тот же текст обычным сообщением с клавиатурой, исход «ушло запасным»; лог один раз на два отказа", async () => {
    const s = setup(() => refusal(400));
    expect(await s.messenger.send("123456", RICH)).toEqual({ status: "sent", fallback: true });
    expect(s.plain).toEqual([["123456", RICH.text, undefined, { keyboard: KEYBOARD }]]);
    expect(await s.messenger.send("123456", RICH)).toEqual({ status: "sent", fallback: true });
    expect(s.logs).toEqual([{ module: "bot", event: "rich_unavailable", code: 400 }]);
  });

  it("404 — то же", async () => {
    const s = setup(() => refusal(404, "Not Found"));
    expect(await s.messenger.send("123456", RICH)).toEqual({ status: "sent", fallback: true });
    expect(s.plain).toHaveLength(1);
    expect(s.logs).toEqual([{ module: "bot", event: "rich_unavailable", code: 404 }]);
  });

  it("после отказа 30 минут простой текст сразу, без sendRichMessage; через 30 минут и 1 мс метод пробуется снова", async () => {
    let failing = true;
    const s = setup(() => (failing ? refusal(400) : null));
    await s.messenger.send("1", RICH);
    expect(s.rich).toHaveLength(1);

    s.advance(RICH_RETRY_MS - 1);
    expect(await s.messenger.send("1", RICH)).toEqual({ status: "sent", fallback: true });
    expect(s.rich).toHaveLength(1);
    expect(s.plain).toHaveLength(2);

    s.advance(2);
    failing = false;
    expect(await s.messenger.send("1", RICH)).toEqual({ status: "sent" });
    expect(s.rich).toHaveLength(2);
    expect(RICH_RETRY_MS).toBe(30 * 60_000);
  });

  it("rich_unavailable — одна строка на паузу: новая пауза после сбоя метода — новая строка", async () => {
    const s = setup(() => refusal(400));
    await s.messenger.send("1", RICH);
    await s.messenger.send("1", RICH);
    s.advance(RICH_RETRY_MS + 1);
    await s.messenger.send("1", RICH);
    await s.messenger.send("1", RICH);
    expect(s.logs).toHaveLength(2);
    expect(s.rich).toHaveLength(2);
  });

  it("400 «chat not found» — игрок заблокирован, запасной текст не отправляется, пауза не включается", async () => {
    const s = setup(() => refusal(400, "Bad Request: chat not found"));
    expect(await s.messenger.send("1", RICH)).toEqual({ status: "blocked" });
    expect(s.plain).toEqual([]);
    expect(await s.messenger.send("1", RICH)).toEqual({ status: "blocked" });
    expect(s.rich).toHaveLength(2);
    expect(s.logs).toEqual([]);
  });

  it("403 — blocked, 429 — retry, сеть — retry: без запасного текста и без паузы", async () => {
    const cases: [Failure, unknown][] = [
      [refusal(403, "Forbidden: bot was blocked by the user"), { status: "blocked" }],
      [new TelegramApiError("sendRichMessage", 429, "Too Many Requests", 7), { status: "retry", afterSec: 7 }],
      [new TelegramApiError("sendRichMessage", 0, "сеть недоступна (TypeError)", null), { status: "retry", afterSec: 5 }],
    ];
    for (const [failure, outcome] of cases) {
      const s = setup(() => failure);
      expect(await s.messenger.send("1", RICH)).toEqual(outcome);
      expect(s.plain).toEqual([]);
      await s.messenger.send("1", RICH);
      expect(s.rich).toHaveLength(2);
    }
  });

  it("чужая ошибка не прячется под исход", async () => {
    const s = setup(() => new Error("баг"));
    await expect(s.messenger.send("1", RICH)).rejects.toThrow("баг");
  });

  it("запасной текст тоже не ушёл — исход берётся из него, без отметки «запасным»", async () => {
    const s = setup(
      () => refusal(400),
      () => new TelegramApiError("sendMessage", 403, "Forbidden: bot was blocked by the user", null),
    );
    expect(await s.messenger.send("1", RICH)).toEqual({ status: "blocked" });
  });

  it("битая кнопка действия — отказ до сети, как у обычного сообщения", async () => {
    const s = setup();
    expect(await s.messenger.send("1", { ...RICH, action: { text: "x", data: "я".repeat(33) } })).toEqual({ status: "failed", reason: "bad_action" });
    expect(s.rich).toEqual([]);
  });
});
