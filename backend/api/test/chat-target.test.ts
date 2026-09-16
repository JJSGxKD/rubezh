import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { chatFields, isChatTarget, parseChatTarget, sameChat } from "../src/modules/telegram/chat-target.js";

// Адрес чата: id или id:тема (docs/20-env-and-ports.md §3). У каждого потока
// уведомлений свой адрес, пустой — берётся общий.

const base = { TELEGRAM_BOT_TOKEN: "1:T", TELEGRAM_BOT_UPDATES: "polling", ADMIN_TELEGRAM_IDS: "111" };

describe("адрес чата", () => {
  it("разбирает id и id:тему, отбрасывает мусор", () => {
    expect(parseChatTarget("-1001234567890")).toEqual({ chatId: "-1001234567890", threadId: null });
    expect(parseChatTarget(" -1001234567890:57 ")).toEqual({ chatId: "-1001234567890", threadId: 57 });
    expect(parseChatTarget("645259468")).toEqual({ chatId: "645259468", threadId: null });
    expect(parseChatTarget("")).toBeNull();
    expect(parseChatTarget("@rubezh_chat")).toBeNull();
    expect(parseChatTarget("-100:abc")).toBeNull();
  });

  it("тему добавляет в запрос, только когда она есть", () => {
    expect(chatFields("-100")).toEqual({ chat_id: "-100" });
    expect(chatFields({ chatId: "-100", threadId: 7 })).toEqual({ chat_id: "-100", message_thread_id: 7 });
    expect(sameChat({ chatId: "-100", threadId: 7 }, "-100")).toBe(true);
    expect(sameChat({ chatId: "-100", threadId: 7 }, "-101")).toBe(false);
  });

  it("пустое значение и мусор различаются: первое допустимо, второе роняет старт", () => {
    expect(isChatTarget("")).toBe(true);
    expect(() => loadAppConfig({ ...base, ADMIN_CHAT_ID: "чат" })).toThrow(/ADMIN_CHAT_ID/);
    expect(() => loadAppConfig({ ...base, ADMIN_CHAT_RUNS: "-100:" })).toThrow(/ADMIN_CHAT_RUNS/);
  });

  it("свой адрес у потока перебивает общий, пустой — берёт общий", () => {
    const config = loadAppConfig({ ...base, ADMIN_CHAT_ID: "-100:1", ADMIN_CHAT_RUNS: "-200:5" });
    expect(config.telegram.chats).toEqual({
      general: { chatId: "-100", threadId: 1 },
      stats: { chatId: "-100", threadId: 1 },
      stressReports: { chatId: "-100", threadId: 1 },
      runReports: { chatId: "-200", threadId: 5 },
      feedback: { chatId: "-100", threadId: 1 },
    });
  });

  it("без общего адреса поток живёт своим, остальные молчат", () => {
    const config = loadAppConfig({ ...base, ADMIN_CHAT_STRESS: "-300" });
    expect(config.telegram.chats.stressReports).toEqual({ chatId: "-300", threadId: null });
    expect(config.telegram.chats.stats).toBeNull();
    expect(config.telegram.chats.general).toBeNull();
  });
});
