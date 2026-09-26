import { describe, expect, it } from "vitest";
import { Messengers, type OutgoingMessage } from "../src/platforms/ports/messenger.js";
import { TelegramApiError } from "../src/platforms/telegram/telegram-bot-api.js";
import { TelegramMessenger, type MessengerBotApi } from "../src/platforms/telegram/telegram-messenger.js";

/**
 * Сообщения игрокам через бота площадки: ответы Telegram переводятся в исходы
 * порта, по которым рассылка решает — отметить блокировку, подождать или
 * записать отказ.
 */

const MESSAGE: OutgoingMessage = { text: "Новый враг ждёт", button: { text: "Играть", url: "https://rubezh.example/r/Ab12Cd34Ef" } };

function api(outcome: Error | null): { api: MessengerBotApi; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    api: {
      sendMessage: async (...args: unknown[]) => {
        calls.push(args);
        if (outcome !== null) throw outcome;
        return 1;
      },
    },
  };
}

describe("бот Telegram как порт сообщений", () => {
  it("текст и кнопка-ссылка уходят в личный чат игрока", async () => {
    const { api: bot, calls } = api(null);
    expect(await new TelegramMessenger(bot, true).send("123456", MESSAGE)).toEqual({ status: "sent" });
    expect(calls[0]).toEqual(["123456", "Новый враг ждёт", undefined, { keyboard: [[{ text: "Играть", url: "https://rubezh.example/r/Ab12Cd34Ef" }]] }]);

    const plain = api(null);
    await new TelegramMessenger(plain.api, true).send("123456", { text: "Без кнопки", button: null });
    expect(plain.calls[0]?.[3]).toEqual({});
  });

  it("403 и «нет чата» — блокировка, 429 и сбой сети — подождать, прочее — отказ", async () => {
    const cases: [Error, unknown][] = [
      [new TelegramApiError("sendMessage", 403, "Forbidden: bot was blocked by the user", null), { status: "blocked" }],
      [new TelegramApiError("sendMessage", 400, "Bad Request: chat not found", null), { status: "blocked" }],
      [new TelegramApiError("sendMessage", 429, "Too Many Requests", 7), { status: "retry", afterSec: 7 }],
      [new TelegramApiError("sendMessage", 0, "сеть недоступна (TypeError)", null), { status: "retry", afterSec: 5 }],
      [new TelegramApiError("sendMessage", 502, "Bad Gateway", null), { status: "retry", afterSec: 5 }],
      [new TelegramApiError("sendMessage", 400, "Bad Request: message is too long", null), { status: "failed", reason: "400" }],
    ];
    for (const [error, outcome] of cases) expect(await new TelegramMessenger(api(error).api, true).send("1", MESSAGE)).toEqual(outcome);
  });

  it("чужая ошибка не прячется под исход, у аккаунта разработчика чата нет", async () => {
    await expect(new TelegramMessenger(api(new Error("баг")).api, true).send("1", MESSAGE)).rejects.toThrow("баг");
    const { api: bot, calls } = api(null);
    expect(await new TelegramMessenger(bot, true).send("dev-1", MESSAGE)).toEqual({ status: "failed", reason: "not_telegram_user" });
    expect(calls).toEqual([]);
  });

  it("площадка без бота и ненастроенный бот — писать некем", () => {
    const { api: bot } = api(null);
    expect(new Messengers([new TelegramMessenger(bot, true)]).for("telegram")?.ratePerSec).toBe(25);
    expect(new Messengers([new TelegramMessenger(bot, false)]).for("telegram")).toBeNull();
    expect(new Messengers([new TelegramMessenger(bot, true)]).for("vk")).toBeNull();
  });
});
