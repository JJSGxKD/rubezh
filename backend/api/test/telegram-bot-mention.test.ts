import { describe, expect, it } from "vitest";
import { BotMentions, containsMention } from "../src/platforms/ports/bot-mention.js";
import { TelegramApiError } from "../src/platforms/telegram/telegram-bot-api.js";
import { TelegramBotMention, type BotMentionApi } from "../src/platforms/telegram/telegram-bot-mention.js";

/**
 * Юзернейм бота в имени и bio игрока (tasks/T-0159, Р110): порт площадки и
 * его реализация для Telegram через `getChat`. Юзернейм в тестах вымышленный.
 */

const BOT = "game_bot";

type Chat = { firstName: string | null; lastName: string | null; bio: string | null };

function fakeApi(chat: Chat | Error): { api: BotMentionApi; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    api: {
      getChat: async (chatId: number) => {
        calls.push(chatId);
        if (chat instanceof Error) throw chat;
        return chat;
      },
    },
  };
}

function adapter(chat: Chat | Error, username: string | null = BOT, enabled = true) {
  const { api, calls } = fakeApi(chat);
  return { calls, mention: new TelegramBotMention(api, () => username, enabled) };
}

describe("containsMention: «@юзернейм» с границами", () => {
  it.each([
    ["Иван @game_bot", true],
    ["Иван @GAME_BOT", true],
    ["@game_bot", true],
    ["@game_bot.", true],
    ["Иван @game_bot, привет", true],
    ["@game_bot2", false],
    ["@game_bot_x", false],
    ["Иван game_bot", false],
    ["mail@game_bot", false],
    ["_@game_bot", false],
    ["", false],
  ])("«%s» → %s", (text, expected) => {
    expect(containsMention(text, BOT)).toBe(expected);
  });

  it("пустое и слишком длинное имя бота — нет, спецзнаки в имени экранируются", () => {
    expect(containsMention("@game_bot", "")).toBe(false);
    expect(containsMention(`@${"a".repeat(65)}`, "a".repeat(65))).toBe(false);
    expect(containsMention("@a.b", "a.b")).toBe(true);
    expect(containsMention("@axb", "a.b")).toBe(false);
  });
});

describe("реестр BotMentions", () => {
  it("отдаёт проверку площадки, только настроенную", () => {
    const configured = adapter({ firstName: null, lastName: null, bio: null }).mention;
    const off = adapter({ firstName: null, lastName: null, bio: null }, BOT, false).mention;
    const unknown = adapter({ firstName: null, lastName: null, bio: null }, null).mention;
    expect(new BotMentions([configured]).for("telegram")).toBe(configured);
    expect(new BotMentions([off]).for("telegram")).toBeNull();
    expect(new BotMentions([unknown]).for("telegram")).toBeNull();
    expect(new BotMentions([configured]).for("vk")).toBeNull();
  });
});

describe("Telegram: имя и bio одним getChat", () => {
  it("юзернейм в фамилии — имя «present», нет — «absent»", async () => {
    const found = await adapter({ firstName: "Иван", lastName: "@game_bot", bio: null }).mention.check("42", ["name"]);
    expect(found).toEqual({ status: "checked", findings: { name: "present" } });
    const absent = await adapter({ firstName: "Иван", lastName: "Петров", bio: null }).mention.check("42", ["name"]);
    expect(absent).toEqual({ status: "checked", findings: { name: "absent" } });
  });

  it("юзернейм в имени без фамилии тоже находится", async () => {
    const outcome = await adapter({ firstName: "Иван @game_bot", lastName: null, bio: null }).mention.check("42", ["name"]);
    expect(outcome).toEqual({ status: "checked", findings: { name: "present" } });
  });

  it("bio нет в ответе — «hidden»; есть без юзернейма — «absent»; с ним — «present»", async () => {
    const hidden = await adapter({ firstName: "Иван", lastName: null, bio: null }).mention.check("42", ["bio"]);
    expect(hidden).toEqual({ status: "checked", findings: { bio: "hidden" } });
    const absent = await adapter({ firstName: "Иван", lastName: null, bio: "Люблю игры" }).mention.check("42", ["bio"]);
    expect(absent).toEqual({ status: "checked", findings: { bio: "absent" } });
    const present = await adapter({ firstName: "Иван", lastName: null, bio: "Играю в @game_bot" }).mention.check("42", ["bio"]);
    expect(present).toEqual({ status: "checked", findings: { bio: "present" } });
  });

  it("запрошено только имя — в findings нет bio; запрошено оба — один вызов getChat", async () => {
    const one = adapter({ firstName: "Иван", lastName: null, bio: "@game_bot" });
    const onlyName = await one.mention.check("42", ["name"]);
    expect(onlyName.status === "checked" && "bio" in onlyName.findings).toBe(false);

    const both = adapter({ firstName: "Иван @game_bot", lastName: null, bio: "@game_bot" });
    const outcome = await both.mention.check("42", ["name", "bio"]);
    expect(outcome).toEqual({ status: "checked", findings: { name: "present", bio: "present" } });
    expect(both.calls).toEqual([42]);
  });

  it("настройки порта: площадка, темп и имя бота", () => {
    const { mention } = adapter({ firstName: null, lastName: null, bio: null });
    expect(mention.platform).toBe("telegram");
    expect(mention.ratePerSec).toBe(25);
    expect(mention.botUsername()).toBe(BOT);
    expect(mention.configured).toBe(true);
  });
});

describe("Telegram: ошибки getChat", () => {
  const fail = (code: number, description: string, retryAfter: number | null = null) =>
    adapter(new TelegramApiError("getChat", code, description, retryAfter)).mention.check("42", ["name", "bio"]);

  it("429 с retry_after — повторить через столько секунд, без него — через пять", async () => {
    expect(await fail(429, "Too Many Requests", 7)).toEqual({ status: "retry", afterSec: 7 });
    expect(await fail(429, "Too Many Requests")).toEqual({ status: "retry", afterSec: 5 });
  });

  it("сбой сети (код 0) и 5xx — повторить через пять секунд", async () => {
    expect(await fail(0, "network")).toEqual({ status: "retry", afterSec: 5 });
    expect(await fail(502, "Bad Gateway")).toEqual({ status: "retry", afterSec: 5 });
  });

  it("400 «нет чата», 403 и прочие коды — проверить нельзя, код в причине", async () => {
    expect(await fail(400, "Bad Request: chat not found")).toEqual({ status: "unavailable", reason: "400" });
    expect(await fail(403, "Forbidden: bot was blocked by the user")).toEqual({ status: "unavailable", reason: "403" });
    expect(await fail(404, "Not Found")).toEqual({ status: "unavailable", reason: "404" });
  });

  it("чужая ошибка пробрасывается, а не прячется в исход", async () => {
    await expect(adapter(new Error("сломалось")).mention.check("42", ["name"])).rejects.toThrow("сломалось");
  });

  it("текст ошибки в причину не попадает: только код", async () => {
    const outcome = await fail(400, "Bad Request: Иван @game_bot");
    expect(JSON.stringify(outcome)).not.toContain("game_bot");
  });
});

describe("Telegram: проверка невозможна", () => {
  it("аккаунт разработчика — не аккаунт площадки, вызова API нет", async () => {
    const { mention, calls } = adapter({ firstName: "Иван", lastName: null, bio: null });
    expect(await mention.check("dev-abc", ["name"])).toEqual({ status: "unavailable", reason: "not_platform_account" });
    expect(await mention.check("", ["name"])).toEqual({ status: "unavailable", reason: "not_platform_account" });
    expect(calls).toEqual([]);
  });

  it("имя бота неизвестно — «bot_unknown», вызова API нет", async () => {
    const { mention, calls } = adapter({ firstName: "Иван", lastName: null, bio: null }, null);
    expect(await mention.check("42", ["name"])).toEqual({ status: "unavailable", reason: "bot_unknown" });
    expect(mention.configured).toBe(false);
    expect(mention.botUsername()).toBeNull();
    expect(calls).toEqual([]);
  });
});
