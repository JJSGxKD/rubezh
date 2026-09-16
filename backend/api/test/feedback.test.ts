import { describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { FeedbackService, type FeedbackBotApi } from "../src/modules/feedback/feedback.service.js";
import { csvOf } from "../src/modules/feedback/feedback-bot.command.js";
import { feedbackMessage } from "../src/modules/feedback/feedback-message.js";
import type { FeedbackRecord, FeedbackRepository, StoredFeedback } from "../src/modules/feedback/feedback.repository.js";
import type { RateLimiter } from "../src/modules/ingest/rate-limiter.js";

// Обратная связь (docs/29-admin-panel.md §6): отзыв ложится в базу и уходит в
// чат администраторов, а `/feedback` выгружает их администратору файлом.

const CHAT = "-1004251205331";

function setup(options: { allow?: boolean; failInsert?: boolean; failChat?: boolean } = {}) {
  const config = loadAppConfig({
    NODE_ENV: "test",
    TELEGRAM_BOT_TOKEN: "1:TEST",
    ADMIN_CHAT_ID: CHAT,
    DATABASE_URL: "postgresql://localhost/test",
  });
  const saved: FeedbackRecord[] = [];
  const repository: FeedbackRepository = {
    insert: async (record) => {
      if (options.failInsert === true) throw new Error("база недоступна");
      saved.push(record);
    },
    recent: async () => [],
  };
  const sent: { chat: unknown; text: string }[] = [];
  const api: FeedbackBotApi = {
    sendMessage: async (chat, text) => {
      if (options.failChat === true) throw new Error("Telegram молчит");
      sent.push({ chat, text });
      return sent.length;
    },
  };
  const limiter = { consume: vi.fn(async () => options.allow ?? true) } as unknown as RateLimiter;

  return { saved, sent, service: new FeedbackService(config, repository, api, limiter) };
}

const identity = { platformUserId: "645259468", ip: "127.0.0.1" };

function body(patch: Record<string, unknown> = {}) {
  return {
    installId: "install-1",
    appVersion: "1.2.3",
    platform: "telegram",
    runs: 7,
    answers: { difficulty: "hard", keepPlaying: "yes" },
    text: "Вороньё не даёт вздохнуть",
    ...patch,
  };
}

describe("приём отзывов", () => {
  it("кладёт отзыв в базу и шлёт его в чат администраторов", async () => {
    const { saved, sent, service } = setup();

    const result = await service.receive(body(), identity);

    expect(result.feedbackId).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved[0]).toMatchObject({ installId: "install-1", runs: 7, platformUserId: "645259468" });
    expect(sent[0]?.text).toContain("Вороньё не даёт вздохнуть");
  });

  it("не роняет запрос, когда Telegram молчит: отзыв уже записан", async () => {
    const { saved, service } = setup({ failChat: true });

    await expect(service.receive(body(), identity)).resolves.toMatchObject({});
    expect(saved).toHaveLength(1);
  });

  it("не принимает пустой отзыв: ни ответов, ни текста", async () => {
    const { service } = setup();
    await expect(service.receive(body({ answers: {}, text: "   " }), identity)).rejects.toThrow(/Пустой отзыв/);
  });

  it("не принимает мусор вместо ответов", async () => {
    const { service } = setup();
    await expect(service.receive(body({ answers: { "Слишком длинный ключ!": "да" } }), identity)).rejects.toThrow(
      /Некорректный отзыв/,
    );
  });

  it("отвечает отказом, когда отзыв не записался: молчаливая потеря хуже ошибки", async () => {
    const { service } = setup({ failInsert: true });
    await expect(service.receive(body(), identity)).rejects.toThrow(/не сохранился/);
  });

  it("упирается в лимит: формой можно долбить так же, как любым эндпоинтом", async () => {
    const { service } = setup({ allow: false });
    await expect(service.receive(body(), identity)).rejects.toThrow(/Слишком много отзывов/);
  });
});

describe("сообщение в чат", () => {
  it("расписывает ответы словами, а незнакомый ключ показывает как есть", () => {
    const text = feedbackMessage({
      answers: { difficulty: "hard", weather: "rain" },
      text: "Пусть будет карта в лесу",
      runs: 3,
      platformUserId: null,
    });

    expect(text).toContain("Сложность: слишком трудно");
    expect(text).toContain("weather: rain");
    expect(text).toContain("Пусть будет карта в лесу");
    expect(text).toContain("без Telegram ID");
  });
});

describe("выгрузка отзывов файлом", () => {
  it("собирает CSV с BOM и экранирует точку с запятой и кавычки", () => {
    const rows: StoredFeedback[] = [
      {
        feedbackId: "f-1",
        installId: "install-1",
        platformUserId: null,
        platform: "telegram",
        appVersion: "1.2.3",
        answers: { difficulty: "fine" },
        text: 'Текст; с "кавычками"',
        runs: 2,
        createdAt: new Date("2026-09-16T10:00:00.000Z"),
      },
    ];

    const csv = csvOf(rows);

    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("difficulty=fine");
    expect(csv).toContain('"Текст; с ""кавычками"""');
  });
});
