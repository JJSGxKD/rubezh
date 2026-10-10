import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { loadAppConfig } from "../src/config/app-config.js";
import { FeedbackService, type FeedbackBotApi } from "../src/modules/feedback/feedback.service.js";
import { csvOf } from "../src/modules/feedback/feedback-bot.command.js";
import { feedbackMessage } from "../src/modules/feedback/feedback-message.js";
import type { FeedbackRecord, FeedbackRepository, StoredFeedback } from "../src/modules/feedback/feedback.repository.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { targetsOf } from "./helpers/notify-targets.js";

// Обратная связь (docs/29-admin-panel.md §6): отзыв ложится в базу и уходит в
// чат администраторов, а `/feedback` выгружает их администратору файлом.

const CHAT = "-1004251205331";

function setup(options: { allow?: boolean; real?: boolean; failInsert?: boolean; failChat?: boolean } = {}) {
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
  // `real` — настоящий лимитер на памяти: Redis недоступен, счёт идёт в процессе
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;
  const limiter = options.real === true
    ? new RateLimiter(unavailableRedis)
    : ({ consume: vi.fn(async () => options.allow ?? true) } as unknown as RateLimiter);

  return { saved, sent, service: new FeedbackService(config, targetsOf(config), repository, api, limiter) };
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

describe("отзыв без подписи запуска", () => {
  const unsigned = (ip: string) => ({ platformUserId: null, ip });
  const unsignedBody = (n: number) => body({ installId: `install-${n}` });

  it("не больше трёх в час с одного адреса, с другого адреса — снова можно", async () => {
    const { saved, service } = setup({ real: true });

    for (let n = 1; n <= 3; n += 1) await service.receive(unsignedBody(n), unsigned("10.0.0.1"));
    await expect(service.receive(unsignedBody(4), unsigned("10.0.0.1"))).rejects.toThrow(/Слишком много отзывов/);
    await service.receive(unsignedBody(5), unsigned("10.0.0.2"));

    expect(saved).toHaveLength(4);
  });

  it("лимит без подписи не тратится подписанными отзывами", async () => {
    const { saved, service } = setup({ real: true });

    // пять отзывов игрока с одного адреса — до лимита `user` (5), а не до трёх
    for (let n = 1; n <= 5; n += 1) await service.receive(body({ installId: `install-${n}` }), identity);
    await expect(service.receive(body({ installId: "install-6" }), identity)).rejects.toThrow(/Слишком много отзывов/);

    expect(saved).toHaveLength(5);
  });

  it("в чат уходит не больше 20 карточек в час на всех, остальные отзывы сохранены", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    try {
      const { saved, sent, service } = setup({ real: true });

      for (let n = 1; n <= 21; n += 1) await service.receive(unsignedBody(n), unsigned(`10.0.1.${n}`));

      expect(saved).toHaveLength(21);
      expect(sent).toHaveLength(20);
      const skipped = log.mock.calls.filter(([message]) => String(message).includes("notify_skipped_unsigned"));
      expect(skipped).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it("лог о пропущенной карточке — не чаще раза в час", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    try {
      const { sent, service } = setup({ real: true });

      for (let n = 1; n <= 23; n += 1) await service.receive(unsignedBody(n), unsigned(`10.0.2.${n}`));

      expect(sent).toHaveLength(20);
      const skipped = log.mock.calls.filter(([message]) => String(message).includes("notify_skipped_unsigned"));
      expect(skipped).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it("подписанный отзыв после исчерпания потолка карточек всё равно уходит в чат", async () => {
    const { sent, service } = setup({ real: true });

    for (let n = 1; n <= 21; n += 1) await service.receive(unsignedBody(n), unsigned(`10.0.3.${n}`));
    await service.receive(body({ installId: "signed-1" }), identity);

    expect(sent).toHaveLength(21);
    expect(sent[20]?.text).toContain("645259468");
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

  it("сведения об устройстве подписаны темой, а не сырым ключом", () => {
    const text = feedbackMessage({ answers: { topic: "device_info" }, text: "Android 14, WebGL 2", runs: 5, platformUserId: "42" });

    expect(text).toContain("Тема: сведения об устройстве");
    expect(text).toContain("Android 14, WebGL 2");
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
