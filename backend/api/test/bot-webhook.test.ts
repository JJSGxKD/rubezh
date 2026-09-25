import "reflect-metadata";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Module, type Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { BotRouter } from "../src/platforms/telegram/bot-router.js";
import { BotUpdateDedupe, BotWebhookController } from "../src/platforms/telegram/bot-webhook.controller.js";
import { TelegramBotApi, type TelegramUpdate } from "../src/platforms/telegram/telegram-bot-api.js";
import { multipartOf } from "./helpers/multipart.js";

// Вебхук бота (docs/28-diagnostics.md §6.1.3–§6.1.5).

const TOKEN = "123456:TEST-webhook";
const CLOUD_API = "https://api.telegram.org";
const SECRET = "s3cret-webhook-token-0123456789abcdef";

/** Redis в памяти: ровно те команды, которыми вебхук отсекает повторы. */
function memoryRedis(): Redis {
  const keys = new Set<string>();
  return {
    set: async (key: string, _value: string, ..._args: unknown[]) => {
      if (keys.has(key)) return null;
      keys.add(key);
      return "OK";
    },
  } as unknown as Redis;
}

function update(id: number, text = "/start"): TelegramUpdate {
  return { update_id: id, message: { message_id: id, date: 1, text, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false, first_name: "Анна" } } };
}

describe("вебхук бота", () => {
  let app: NestFastifyApplication | null = null;
  let seen: number[];
  let release: () => void;

  async function start(env: Record<string, string> = {}): Promise<NestFastifyApplication> {
    seen = [];
    const gate = new Promise<void>((resolve) => (release = resolve));
    const router = new BotRouter();
    router.register({
      name: "slow",
      async handle(incoming) {
        seen.push(incoming.update_id);
        // Обработчик дольше ответа: вебхук не должен его ждать.
        await gate;
        return true;
      },
    });
    const config = loadAppConfig({
      NODE_ENV: "test",
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_BOT_UPDATES: "webhook",
      TELEGRAM_WEBHOOK_SECRET: SECRET,
      ...env,
    });
    @Module({
      controllers: [BotWebhookController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: REDIS, useValue: memoryRedis() },
        { provide: BotRouter, useValue: router },
        BotUpdateDedupe,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule as Type<unknown>, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  }

  afterEach(async () => {
    release();
    await app?.close();
    app = null;
  });

  function post(target: NestFastifyApplication, body: unknown, secret: string | null = SECRET) {
    return target.inject({
      method: "POST",
      url: "/api/v1/bot/webhook",
      headers: secret === null ? {} : { "x-telegram-bot-api-secret-token": secret },
      payload: body as object,
    });
  }

  it("отклоняет обновление без секретного токена или с чужим", async () => {
    const target = await start();
    expect((await post(target, update(1), null)).statusCode).toBe(401);
    expect((await post(target, update(1), `${SECRET}x`)).statusCode).toBe(401);
    expect(seen).toEqual([]);
  });

  it("отвечает сразу, не дожидаясь обработчика, и не обрабатывает повтор update_id", async () => {
    const target = await start();
    const first = await post(target, update(10));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ data: { accepted: true } });
    const repeat = await post(target, update(10));
    expect(repeat.json()).toEqual({ data: { accepted: false } });
    expect(seen).toEqual([10]);
  });

  it("непонятное обновление принимает, чтобы Telegram его не повторял", async () => {
    const target = await start();
    const response = await post(target, { update_id: "не число" });
    expect(response.statusCode).toBe(200);
    expect(seen).toEqual([]);
  });

  it("без режима вебхука эндпоинта нет", async () => {
    const target = await start({ TELEGRAM_BOT_UPDATES: "polling" });
    expect((await post(target, update(3))).statusCode).toBe(404);
  });

  it("режим вебхука без секрета не стартует", () => {
    expect(() => loadAppConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_BOT_UPDATES: "webhook" })).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
    expect(() => loadAppConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: "short" })).toThrow();
  });
});

describe("клиент Bot API: кнопки, картинки, документы", () => {
  function recorder(result: unknown) {
    const calls: { url: string; init: RequestInit }[] = [];
    const api = new TelegramBotApi(TOKEN, CLOUD_API, async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    });
    return { calls, api };
  }

  it("отдаёт file_id крупнейшего размера и шлёт картинку по нему без загрузки", async () => {
    const { calls, api } = recorder({ message_id: 5, photo: [{ file_id: "small" }, { file_id: "large" }] });
    const sent = await api.sendPhoto("7", Buffer.from("png"), "подпись", undefined, {
      keyboard: [[{ text: "Играть", web_app: { url: "https://game.example" } }]],
    });
    expect(sent).toEqual({ messageId: 5, fileId: "large" });
    const form = await multipartOf(calls[0]?.init ?? {});
    expect(JSON.parse(String(form.get("reply_markup")))).toEqual({ inline_keyboard: [[{ text: "Играть", web_app: { url: "https://game.example" } }]] });

    await api.sendPhoto("7", "large", "подпись");
    expect(JSON.parse(String(calls[1]?.init.body))).toMatchObject({ chat_id: "7", photo: "large" });
  });

  it("задаёт команды для всех и отдельно для чата администратора", async () => {
    const { calls, api } = recorder(true);
    await api.setMyCommands([{ command: "start", description: "Начать" }], null, undefined, "ru");
    await api.setMyCommands([{ command: "export", description: "Выгрузка" }], "111");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ scope: { type: "default" }, language_code: "ru" });
    expect(JSON.parse(String(calls[1]?.init.body))).toMatchObject({ scope: { type: "chat", chat_id: "111" } });
  });

  it("отправляет документ с диска формой", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rubezh-doc-"));
    try {
      const path = join(dir, "export.zip");
      writeFileSync(path, "zip-bytes");
      const { calls, api } = recorder({ message_id: 9 });
      await api.sendDocument("111", path, "rubezh-export.zip", "Выгрузка");
      const form = await multipartOf(calls[0]?.init ?? {});
      const file = form.get("document") as File;
      expect(file.name).toBe("rubezh-export.zip");
      expect(await file.text()).toBe("zip-bytes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
