import "reflect-metadata";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Module, type Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { BotUpdateQueue } from "../src/platforms/telegram/bot-update-queue.js";
import { BotWebhookController } from "../src/platforms/telegram/bot-webhook.controller.js";
import { TelegramBotApi, type TelegramUpdate } from "../src/platforms/telegram/telegram-bot-api.js";
import { multipartOf } from "./helpers/multipart.js";

// Вебхук бота (docs/28-diagnostics.md §6.1.3–§6.1.5).

const TOKEN = "123456:TEST-webhook";
const CLOUD_API = "https://api.telegram.org";
const SECRET = "s3cret-webhook-token-0123456789abcdef";

function update(id: number, text = "/start"): TelegramUpdate {
  return { update_id: id, message: { message_id: id, date: 1, text, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false, first_name: "Анна" } } };
}

describe("вебхук бота", () => {
  let app: NestFastifyApplication | null = null;
  let enqueued: TelegramUpdate[];
  let release: () => void;
  let enqueueGate: Promise<void> | null;
  let enqueueFailure: Error | null;

  /** Очередь обновлений: пишет, что в неё поставили; может зависнуть до `release` или отказать. */
  async function start(env: Record<string, string> = {}): Promise<NestFastifyApplication> {
    enqueued = [];
    enqueueGate = null;
    enqueueFailure = null;
    release = () => undefined;
    const updates = {
      async enqueue(incoming: TelegramUpdate): Promise<void> {
        if (enqueueFailure !== null) throw enqueueFailure;
        if (enqueueGate !== null) await enqueueGate;
        enqueued.push(incoming);
      },
    };
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
        { provide: BotUpdateQueue, useValue: updates },
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

  it("отклоняет обновление без секретного токена или с чужим, не доходя до очереди", async () => {
    const target = await start();
    expect((await post(target, update(1), null)).statusCode).toBe(401);
    expect((await post(target, update(1), `${SECRET}x`)).statusCode).toBe(401);
    expect(enqueued).toEqual([]);
  });

  it("верный секрет и обновление: оно в очереди, ответ 200 `accepted`", async () => {
    const target = await start();

    const response = await post(target, update(10));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { accepted: true } });
    expect(enqueued).toEqual([update(10)]);
  });

  it("сначала очередь, потом ответ: пока обновление не записано, Telegram «принято» не получает", async () => {
    const target = await start();
    enqueueGate = new Promise<void>((resolve) => (release = resolve));

    let answered = false;
    const pending = post(target, update(11)).then((response) => {
      answered = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(answered).toBe(false);

    release();
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { accepted: true } });
    expect(enqueued).toEqual([update(11)]);
  });

  it("очередь не приняла обновление (Redis недоступен): 503 без `accepted` — Telegram повторит доставку сам", async () => {
    const target = await start();
    enqueueFailure = new Error("Redis недоступен");

    const response = await post(target, update(12));

    expect(response.statusCode).toBe(503);
    expect(JSON.stringify(response.json())).not.toContain("accepted");
    expect(JSON.stringify(response.json())).not.toContain("Redis недоступен");
    expect(enqueued).toEqual([]);
  });

  it("непонятное обновление принимает, чтобы Telegram его не повторял, но в очередь не ставит", async () => {
    const target = await start();
    const response = await post(target, { update_id: "не число" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { accepted: false } });
    expect(enqueued).toEqual([]);
  });

  it("без режима вебхука эндпоинта нет", async () => {
    const target = await start({ TELEGRAM_BOT_UPDATES: "polling" });
    expect((await post(target, update(3))).statusCode).toBe(404);
    expect(enqueued).toEqual([]);
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
