import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { Logger, Module, type Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_CONFIG, loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import type { ExternalIdentityService } from "../src/modules/external-identity/external-identity.service.js";
import { GENERATED_SECRET_BYTES, SECRETS, secretByKey, secretProblem, type SecretDefinition } from "../src/modules/secrets/secret-catalog.js";
import { SECRETS_READER, type SecretsReader } from "../src/modules/secrets/secrets.service.js";
import { SETTINGS, type SettingDefinition } from "../src/modules/settings/setting-catalog.js";
import { NO_ACHIEVEMENT_FIELDS, type TaskDef } from "../src/modules/tasks/task-rules.js";
import type { TasksRepository } from "../src/modules/tasks/tasks.repository.js";
import { MAX_API_BASE, MaxApiError, MaxBotApi } from "../src/platforms/max/max-bot-api.js";
import { MaxChannelLinks } from "../src/platforms/max/max-channel-links.js";
import { MaxSubscriptionService } from "../src/platforms/max/max-subscription.service.js";
import { MaxUpdateQueue } from "../src/platforms/max/max-update-queue.js";
import { MaxUpdatesWorker } from "../src/platforms/max/max-updates.worker.js";
import { MaxWebhookController } from "../src/platforms/max/max-webhook.controller.js";
import type { ConsumeOutcome } from "../src/modules/external-identity/external-identity-rules.js";
import { redisDatabase } from "./helpers/redis-database.js";

/**
 * Бот MAX для заданий (docs/35-stage4-plan.md Р188, tasks/T-0379): вебхук с
 * секретом и очередью, ответы бота на старт с кодом, подписка вебхука у MAX
 * и клиент Bot API. Сеть — подмена `fetch`, Redis — живой (адрес в
 * PLAYTEST_TEST_REDIS_URL, без него эти тесты пропускаются).
 */

const TOKEN = "f9LHodD0cOKoGIx5aSDsQjL_9dKfC1xj6lIhSgkxClhAv6nvLWSOvaCqSbc8jm";
/** Секрет в том виде, в каком его принимает MAX и присылает в заголовке: латиница, цифры, дефис. */
const SECRET = "Abc123-secretForMaxWebhook-0123456789XYZ";
const PUBLIC_API = "https://api.example.test";
const WEBHOOK_URL = `${PUBLIC_API}/api/v1/max/webhook`;
const CODE = "AbCd1234EfGh5678";
const CHANNEL_URL = "https://max.ru/join/rubezh-channel";

function config(env: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", PUBLIC_API_URL: PUBLIC_API, ...env } as NodeJS.ProcessEnv);
}

/** Ключи панели в памяти: заданный — как значение из базы, остальные не заданы нигде. */
function secretsOf(values: Record<string, string>): SecretsReader {
  return { get: (secret) => values[secret.key] ?? null };
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** `fetch` с записью вызовов: что и куда ушло — видно тесту. */
function stub(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return await handler(String(input), init ?? {});
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function botStarted(userId = 70_000_000_123, payload: string | null = CODE, timestamp = 1_731_400_000_000) {
  return {
    update_type: "bot_started",
    timestamp,
    chat_id: 555_000,
    user: { user_id: userId, first_name: "Анна", is_bot: false, last_activity_time: 1_731_399_999_000 },
    payload,
    user_locale: "ru",
  };
}

describe("ключи и настройка MAX в каталогах", () => {
  it("ключ бота: сервис MAX, без запасного значения в окружении, подсказка про администратора канала", () => {
    const secret = SECRETS.maxBotToken;

    expect(secret.key).toBe("max.bot-token");
    expect(secret.service).toBe("MAX");
    expect((secret as SecretDefinition).fromEnv(config())).toBeNull();
    expect(secret.hint).toContain("администратором канала");
    expect(secret.hint).toContain("Без ключа");
    expect(secretByKey("max.bot-token")).toBe(secret);
    expect(secretProblem(secret, TOKEN)).toBeNull();
    expect(secretProblem(secret, "с пробелом и кириллицей")).not.toBeNull();
  });

  it("проверка ключа — `GET /me` бота с ключом в заголовке Authorization", async () => {
    const { calls, fetchImpl } = stub(() => json({ user_id: 1, first_name: "Рубеж", is_bot: true, username: "rubezh_bot" }));

    const result = await SECRETS.maxBotToken.check?.(TOKEN, fetchImpl);

    expect(result).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${MAX_API_BASE}/me`);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(TOKEN);
    expect(calls[0]?.url).not.toContain(TOKEN);
  });

  it("проверка ключа: MAX не принял — сообщение называет MAX и не раскрывает ключ", async () => {
    const { fetchImpl } = stub(() => json({ code: "verify.token", message: "Invalid access_token" }, 401));

    const result = await SECRETS.maxBotToken.check?.(TOKEN, fetchImpl);

    expect(result?.ok).toBe(false);
    expect(result?.message).toContain("MAX");
    expect(result?.message).not.toContain(TOKEN);
  });

  it("секрет вебхука: создаёт сервер, значение его генератора проходит шаблон, адрес без секрета", () => {
    const secret = SECRETS.maxWebhookSecret;
    const generated = randomBytes(GENERATED_SECRET_BYTES).toString("base64url");

    expect(secret.key).toBe("max.webhook-secret");
    expect(secret.service).toBe("MAX");
    expect((secret as SecretDefinition).fromEnv(config())).toBeNull();
    expect(secret.generated).toBeDefined();
    expect(secretProblem(secret, generated)).toBeNull();
    expect(secret.generated?.reveal(generated, config())).toBe(WEBHOOK_URL);
    expect(secret.generated?.reveal(generated, config())).not.toContain(generated);
  });

  it("настройка `max.bot-username`: имя без `@`, по умолчанию пусто", () => {
    const setting = SETTINGS.maxBotUsername;

    expect(setting.key).toBe("max.bot-username");
    expect(setting.kind).toBe("text");
    expect(setting.fallback).toBe("");
    expect((setting as SettingDefinition).fromEnv(config())).toBeNull();
    for (const good of ["", "rubezh_bot", "id7701234567_bot"]) expect(setting.schema.safeParse(good).success, good).toBe(true);
    for (const bad of ["@rubezh_bot", "rubezh bot", "ru/bot", "https://max.ru/rubezh_bot", "a".repeat(65)]) expect(setting.schema.safeParse(bad).success, bad).toBe(false);
  });
});

describe("клиент Bot API MAX", () => {
  function apiOf(handler: Handler, tokenOf: () => string | null = () => TOKEN) {
    const { calls, fetchImpl } = stub(handler);
    return { calls, api: new MaxBotApi(tokenOf, fetchImpl) };
  }

  it("адрес API — platform-api2.max.ru, а не старый домен", () => {
    expect(MAX_API_BASE).toBe("https://platform-api2.max.ru");
  });

  it("`me` — бот по ключу", async () => {
    const { calls, api } = apiOf(() => json({ user_id: 5, first_name: "Рубеж", is_bot: true, username: "rubezh_bot", description: null }));

    await expect(api.me()).resolves.toEqual({ userId: 5, username: "rubezh_bot" });
    expect(calls[0]?.url).toBe(`${MAX_API_BASE}/me`);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(TOKEN);
  });

  it("`subscriptions` — адреса и типы событий действующих подписок", async () => {
    const { calls, api } = apiOf(() =>
      json({
        subscriptions: [
          { url: WEBHOOK_URL, time: 1_731_400_000_000, update_types: ["bot_started"] },
          { url: "https://other.example.test/hook", time: 1_731_400_000_001, update_types: null },
        ],
      }),
    );

    await expect(api.subscriptions()).resolves.toEqual([
      { url: WEBHOOK_URL, updateTypes: ["bot_started"] },
      { url: "https://other.example.test/hook", updateTypes: null },
    ]);
    expect(calls[0]?.url).toBe(`${MAX_API_BASE}/subscriptions`);
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("`subscribe` — POST с адресом, типами событий и секретом в теле; ключ — в заголовке", async () => {
    const { calls, api } = apiOf(() => json({ success: true }));

    await api.subscribe(WEBHOOK_URL, SECRET, ["bot_started"]);

    expect(calls[0]?.url).toBe(`${MAX_API_BASE}/subscriptions`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ url: WEBHOOK_URL, update_types: ["bot_started"], secret: SECRET });
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(TOKEN);
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toContain("application/json");
  });

  it("`subscribe`: MAX ответил 200, но `success: false` — это отказ, а не подписка", async () => {
    const { api } = apiOf(() => json({ success: false, code: "verify.url", message: "Wrong url" }));

    const error = await api.subscribe(WEBHOOK_URL, SECRET, ["bot_started"]).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MaxApiError);
    expect(error).toMatchObject({ code: "verify.url", retryable: false });
  });

  it("`sendMessage` — личное сообщение игроку с кнопками-ссылками, каждая в своей строке", async () => {
    const { calls, api } = apiOf(() => json({ message: { body: { mid: "m1" } } }));

    await api.sendMessage("70000000123", "Готово!", [
      { text: "Открыть канал 1", url: CHANNEL_URL },
      { text: "Открыть канал 2", url: "https://max.ru/join/second" },
    ]);

    const url = new URL(calls[0]?.url ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(`${MAX_API_BASE}/messages`);
    expect(url.searchParams.get("user_id")).toBe("70000000123");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      text: "Готово!",
      attachments: [
        {
          type: "inline_keyboard",
          payload: {
            buttons: [
              [{ type: "link", text: "Открыть канал 1", url: CHANNEL_URL }],
              [{ type: "link", text: "Открыть канал 2", url: "https://max.ru/join/second" }],
            ],
          },
        },
      ],
    });
  });

  it("`sendMessage` без кнопок — только текст", async () => {
    const { calls, api } = apiOf(() => json({ message: {} }));

    await api.sendMessage("70000000123", "Ссылка устарела.");

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ text: "Ссылка устарела." });
  });

  it.each([
    ["429", 429, true],
    ["500", 500, true],
    ["401", 401, false],
    ["403", 403, false],
  ])("ошибка %s — MaxApiError, повторять ли — по статусу", async (_name, status, retryable) => {
    const { api } = apiOf(() => json({ code: "x", message: "y" }, status));

    const error = await api.sendMessage("70000000123", "текст").then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MaxApiError);
    expect(error).toMatchObject({ status, retryable });
  });

  it("нет ключа — MaxApiError без запроса", async () => {
    const { calls, api } = apiOf(() => json({}), () => null);

    await expect(api.me()).rejects.toBeInstanceOf(MaxApiError);
    expect(calls).toEqual([]);
  });
});

describe("вебхук MAX: доступ и очередь", () => {
  let app: NestFastifyApplication | null = null;
  let enqueued: unknown[];
  let enqueueFailure: Error | null;
  let logged: { event: string; fields: Record<string, unknown> }[];

  /** Очередь событий: пишет, что в неё поставили; может отказать. */
  async function start(values: Record<string, string> = { [SECRETS.maxBotToken.key]: TOKEN, [SECRETS.maxWebhookSecret.key]: SECRET }): Promise<NestFastifyApplication> {
    enqueued = [];
    enqueueFailure = null;
    const updates = {
      async enqueue(event: unknown): Promise<void> {
        if (enqueueFailure !== null) throw enqueueFailure;
        enqueued.push(event);
      },
    };
    @Module({
      controllers: [MaxWebhookController],
      providers: [
        { provide: APP_CONFIG, useValue: config() },
        { provide: SECRETS_READER, useValue: secretsOf(values) },
        { provide: MaxUpdateQueue, useValue: updates },
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule as Type<unknown>, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  }

  beforeEach(() => {
    logged = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((line: unknown) => {
        try {
          const fields = JSON.parse(String(line)) as Record<string, unknown>;
          logged.push({ event: String(fields.event), fields });
        } catch {
          // строка не JSON — тестам она не нужна
        }
      });
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    app = null;
  });

  function post(target: NestFastifyApplication, body: unknown, secret: string | null = SECRET) {
    return target.inject({
      method: "POST",
      url: "/api/v1/max/webhook",
      headers: secret === null ? {} : { "x-max-bot-api-secret": secret },
      payload: body as object,
    });
  }

  it("нет ключа бота — эндпоинта нет: 404, очередь пуста", async () => {
    const target = await start({ [SECRETS.maxWebhookSecret.key]: SECRET });

    expect((await post(target, botStarted())).statusCode).toBe(404);
    expect(enqueued).toEqual([]);
  });

  it("нет секрета вебхука — тоже 404: без секрета события не принимаются", async () => {
    const target = await start({ [SECRETS.maxBotToken.key]: TOKEN });

    expect((await post(target, botStarted(), null)).statusCode).toBe(404);
    expect((await post(target, botStarted(), SECRET)).statusCode).toBe(404);
    expect(enqueued).toEqual([]);
  });

  it("секрет не пришёл или не совпал — 401, очередь пуста", async () => {
    const target = await start();

    expect((await post(target, botStarted(), null)).statusCode).toBe(401);
    expect((await post(target, botStarted(), `${SECRET}x`)).statusCode).toBe(401);
    expect((await post(target, botStarted(), SECRET.slice(0, -1))).statusCode).toBe(401);
    expect((await post(target, botStarted(), "")).statusCode).toBe(401);
    expect(enqueued).toEqual([]);
  });

  it("секрет проверяется до разбора тела: мусор с чужим секретом — 401, а не «принято»", async () => {
    const target = await start();

    const response = await post(target, { update_type: 42, user: "не объект" }, "wrong-secret");

    expect(response.statusCode).toBe(401);
    expect(JSON.stringify(response.json())).not.toContain("accepted");
  });

  it("секрет, выданный панелью с подчёркиванием, MAX получает с дефисом — и вебхук сверяет тот же вид", async () => {
    const target = await start({ [SECRETS.maxBotToken.key]: TOKEN, [SECRETS.maxWebhookSecret.key]: "aaaa_bbbb_cccc_dddd_eeee_ffff_gggg_hhhh" });

    expect((await post(target, botStarted(), "aaaa-bbbb-cccc-dddd-eeee-ffff-gggg-hhhh")).statusCode).toBe(200);
    expect((await post(target, botStarted(), "aaaa_bbbb_cccc_dddd_eeee_ffff_gggg_hhhh")).statusCode).toBe(401);
  });

  it("`bot_started` с верным секретом: событие в очереди, ответ 200", async () => {
    const target = await start();

    const response = await post(target, botStarted());

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { accepted: true } });
    expect(enqueued).toEqual([expect.objectContaining({ update_type: "bot_started", payload: CODE, user: expect.objectContaining({ user_id: 70_000_000_123 }) as unknown })]);
  });

  it("прочие типы событий — 200 без обработки: в очередь не идут", async () => {
    const target = await start();

    const response = await post(target, { update_type: "message_created", timestamp: 1, message: { body: { text: "привет" } } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { accepted: false } });
    expect(enqueued).toEqual([]);
  });

  it("`bot_started` без пользователя — принят, но в очередь не идёт: повтор его не исправит", async () => {
    const target = await start();

    const response = await post(target, { update_type: "bot_started", timestamp: 1_731_400_000_000, payload: CODE });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { accepted: false } });
    expect(enqueued).toEqual([]);
  });

  it("очередь не приняла событие (Redis недоступен) — 503 без деталей: MAX повторит доставку", async () => {
    const target = await start();
    enqueueFailure = new Error("Redis недоступен: 10.0.0.5:6379");

    const response = await post(target, botStarted());

    expect(response.statusCode).toBe(503);
    expect(JSON.stringify(response.json())).not.toContain("accepted");
    expect(JSON.stringify(response.json())).not.toContain("10.0.0.5");
    expect(enqueued).toEqual([]);
  });

  it("счётчик `max_webhook` — строкой лога с видом события и исходом, без id игрока и секретов", async () => {
    const target = await start();
    await post(target, botStarted());
    await post(target, { update_type: "message_created", timestamp: 1 });
    await post(target, botStarted(), "wrong-secret");

    const counted = logged.filter((entry) => entry.event === "max_webhook").map((entry) => entry.fields);
    expect(counted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "bot_started", result: "accepted" }),
        expect.objectContaining({ type: "other", result: "ignored" }),
        expect.objectContaining({ type: "unknown", result: "unauthorized" }),
      ]),
    );
    const text = JSON.stringify(logged);
    expect(text).not.toContain("70000000123");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(CODE);
  });
});

describe("очередь событий MAX", () => {
  interface Added {
    name: string;
    data: unknown;
    options: Record<string, unknown>;
  }

  /** Подмена `Queue.add` BullMQ: запоминает, что в очередь поставили. */
  class FakeQueue {
    readonly added: Added[] = [];
    failWith: Error | null = null;

    async add(name: string, data: unknown, options: Record<string, unknown>): Promise<void> {
      if (this.failWith !== null) throw this.failWith;
      this.added.push({ name, data, options });
    }
  }

  function setup(handle: (event: unknown) => Promise<void> = async () => undefined) {
    const handled: unknown[] = [];
    const worker = {
      handle: async (event: unknown): Promise<void> => {
        handled.push(event);
        await handle(event);
      },
    } as unknown as MaxUpdatesWorker;
    const queue = new MaxUpdateQueue(config(), worker);
    const fake = new FakeQueue();
    Object.assign(queue as unknown as { queue: unknown }, { queue: fake });
    return { queue, fake, handled };
  }

  const parsed = (body: ReturnType<typeof botStarted>) => body as unknown as Parameters<MaxUpdateQueue["enqueue"]>[0];

  it("id задания один у повтора того же события — BullMQ второго не заведёт; у других — свои", async () => {
    const { queue, fake } = setup();

    await queue.enqueue(parsed(botStarted()));
    await queue.enqueue(parsed(botStarted()));
    await queue.enqueue(parsed(botStarted(70_000_000_124)));
    await queue.enqueue(parsed(botStarted(70_000_000_123, "ZzYyXx9876543210")));
    await queue.enqueue(parsed(botStarted(70_000_000_123, CODE, 1_731_400_000_001)));

    const ids = fake.added.map((job) => String(job.options.jobId));
    expect(ids[0]).toBe(ids[1]);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id).not.toContain(":");
  });

  it("id задания не содержит кода из ссылки: код одноразовый, но в Redis открытым не лежит", async () => {
    const { queue, fake } = setup();

    await queue.enqueue(parsed(botStarted()));

    expect(String(fake.added[0]?.options.jobId)).not.toContain(CODE);
    expect(fake.added[0]?.options).toMatchObject({ attempts: expect.any(Number) as unknown, removeOnComplete: expect.anything() as unknown });
  });

  it("ошибка постановки (Redis недоступен) бросается вызывающему: вебхук ответит 503", async () => {
    const { queue, fake } = setup();
    fake.failWith = new Error("Redis недоступен");

    await expect(queue.enqueue(parsed(botStarted()))).rejects.toThrow("Redis недоступен");
  });

  it("очередь не запущена — enqueue бросает: молча терять событие нельзя", async () => {
    const queue = new MaxUpdateQueue(config(), { handle: async () => undefined } as unknown as MaxUpdatesWorker);

    await expect(queue.enqueue(parsed(botStarted()))).rejects.toThrow();
  });

  it("задание воркера: событие доходит до обработчика ответов", async () => {
    const { queue, handled } = setup();

    await queue.process({ data: botStarted(), attemptsMade: 0 });

    expect(handled).toEqual([expect.objectContaining({ payload: CODE })]);
  });

  it("данные не по схеме: не бросает (повтор не поможет) и до обработчика не доходит", async () => {
    const { queue, handled } = setup();

    await expect(queue.process({ data: { update_type: "bot_started" }, attemptsMade: 0 })).resolves.toBeUndefined();
    await expect(queue.process({ data: null, attemptsMade: 0 })).resolves.toBeUndefined();

    expect(handled).toEqual([]);
  });

  it("обработчик упал — задание бросает, чтобы BullMQ повторил его", async () => {
    const { queue } = setup(async () => {
      throw new Error("база недоступна");
    });

    await expect(queue.process({ data: botStarted(), attemptsMade: 1 })).rejects.toThrow("база недоступна");
  });
});

// Сквозной: настоящие BullMQ и Redis. Показывает то, чего подмены не покажут:
// повтор того же события не заводит второе задание.
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 8);

describe.skipIf(REDIS_URL === "")("очередь событий MAX на живом Redis", () => {
  let queue: MaxUpdateQueue | null = null;

  afterEach(async () => {
    await queue?.onModuleDestroy();
    queue = null;
  });

  async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("условие не выполнилось за отведённое время");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("повтор того же события обрабатывается один раз, другое событие — отдельно", async () => {
    const userId = 71_000_000_000 + Math.floor(Math.random() * 900_000);
    const stamp = 1_731_400_000_000 + Math.floor(Math.random() * 900_000);
    const seen: number[] = [];
    const worker = {
      handle: async (event: { user: { user_id: number } }): Promise<void> => {
        seen.push(event.user.user_id);
      },
    } as unknown as MaxUpdatesWorker;
    const live = new MaxUpdateQueue(config({ REDIS_URL }), worker);
    await live.onApplicationBootstrap();
    queue = live;
    const event = (id: number) => botStarted(id, CODE, stamp) as unknown as Parameters<MaxUpdateQueue["enqueue"]>[0];

    await live.enqueue(event(userId));
    await live.enqueue(event(userId));
    await live.enqueue(event(userId + 1));
    await until(() => seen.length >= 2);
    // Пауза: если бы повтор прошёл, он обработался бы за это время.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(seen.sort((a, b) => a - b)).toEqual([userId, userId + 1]);
  }, 20_000);
});

describe("ответы бота MAX на старт", () => {
  type Sent = { userId: string; text: string; buttons: readonly { text: string; url: string }[] };

  function setup(outcome: ConsumeOutcome = "linked", urls: readonly string[] = [CHANNEL_URL]) {
    const consumed: { platform: string; code: string; externalUserId: string }[] = [];
    const sent: Sent[] = [];
    const state = { sendFailure: null as Error | null, consumeFailure: null as Error | null };
    const identity = {
      consume: async (platform: string, code: string, externalUserId: string): Promise<ConsumeOutcome> => {
        if (state.consumeFailure !== null) throw state.consumeFailure;
        consumed.push({ platform, code, externalUserId });
        return outcome;
      },
    } as unknown as Pick<ExternalIdentityService, "consume">;
    const api = {
      sendMessage: async (userId: string, text: string, buttons: readonly { text: string; url: string }[] = []): Promise<void> => {
        if (state.sendFailure !== null) throw state.sendFailure;
        sent.push({ userId, text, buttons });
      },
    };
    const worker = new MaxUpdatesWorker(identity, api, { urls: async () => urls });
    return { worker, consumed, sent, state };
  }

  const event = (payload: string | null = CODE, userId = 70_000_000_123) => botStarted(userId, payload) as unknown as Parameters<MaxUpdatesWorker["handle"]>[0];

  it("код из ссылки и id игрока в MAX уходят в связь аккаунтов — площадка `max`", async () => {
    const { worker, consumed } = setup();

    await worker.handle(event());

    expect(consumed).toEqual([{ platform: "max", code: CODE, externalUserId: "70000000123" }]);
  });

  it("связано — «Готово!» и кнопка-ссылка на канал", async () => {
    const { worker, sent } = setup("linked");

    await worker.handle(event());

    expect(sent).toEqual([
      {
        userId: "70000000123",
        text: "Готово! Аккаунт MAX связан с игрой. Подпишись на канал и вернись в игру — нажми «Проверить».",
        buttons: [{ text: "Открыть канал", url: CHANNEL_URL }],
      },
    ]);
  });

  it("уже связано — свой текст и та же кнопка", async () => {
    const { worker, sent } = setup("already");

    await worker.handle(event());

    expect(sent).toEqual([
      { userId: "70000000123", text: "Аккаунт уже связан. Подпишись на канал и нажми «Проверить» в игре.", buttons: [{ text: "Открыть канал", url: CHANNEL_URL }] },
    ]);
  });

  it("занято другим игроком — текст дословно, без кнопки", async () => {
    const { worker, sent } = setup("taken");

    await worker.handle(event());

    expect(sent).toEqual([{ userId: "70000000123", text: "Этот аккаунт MAX уже связан с другим игроком. Связать его второй раз нельзя.", buttons: [] }]);
  });

  it("код протух или чужой — текст дословно, без кнопки", async () => {
    const { worker, sent } = setup("expired");

    await worker.handle(event());

    expect(sent).toEqual([{ userId: "70000000123", text: "Ссылка устарела. Открой задание в игре и нажми «Открыть бота MAX» ещё раз.", buttons: [] }]);
  });

  it.each([[null], [""], ["   "]])("старт без кода (%j) — подсказка, как связать; связь аккаунтов не зовётся", async (payload) => {
    const { worker, consumed, sent } = setup();

    await worker.handle(event(payload));

    expect(consumed).toEqual([]);
    expect(sent).toEqual([{ userId: "70000000123", text: "Чтобы связать аккаунт, открой задание в игре и нажми «Открыть бота MAX»", buttons: [] }]);
  });

  it("код с пробелами по краям обрезается", async () => {
    const { worker, consumed } = setup();

    await worker.handle(event(`  ${CODE}\n`));

    expect(consumed[0]?.code).toBe(CODE);
  });

  it("каналов MAX в каталоге несколько — кнопка на каждый, не больше трёх, в порядке каталога", async () => {
    const urls = ["https://max.ru/join/one", "https://max.ru/join/two", "https://max.ru/join/three", "https://max.ru/join/four"];
    const { worker, sent } = setup("linked", urls);

    await worker.handle(event());

    expect(sent[0]?.buttons.map((button) => button.url)).toEqual(urls.slice(0, 3));
    expect(new Set(sent[0]?.buttons.map((button) => button.text)).size).toBe(3);
  });

  it("задания-канала MAX в каталоге нет — ответ без кнопки: связь уже записана", async () => {
    const { worker, sent } = setup("linked", []);

    await worker.handle(event());

    expect(sent).toHaveLength(1);
    expect(sent[0]?.buttons).toEqual([]);
  });

  it("бот в качестве игрока и неполное событие молча пропускаются", async () => {
    const { worker, consumed, sent } = setup();
    const bot = { ...botStarted(), user: { user_id: 5, first_name: "Бот", is_bot: true } };

    await worker.handle(bot as unknown as Parameters<MaxUpdatesWorker["handle"]>[0]);

    expect(consumed).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("ответ не ушёл — не бросает и связь второй раз не применяет: код уже забран", async () => {
    const { worker, consumed, state } = setup();
    state.sendFailure = new Error("MAX недоступен");
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

    await expect(worker.handle(event())).resolves.toBeUndefined();

    expect(consumed).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("связь не записалась (база недоступна) — бросает: задание очереди повторится", async () => {
    const { worker, sent, state } = setup();
    state.consumeFailure = new Error("база недоступна");

    await expect(worker.handle(event())).rejects.toThrow("база недоступна");

    expect(sent).toEqual([]);
  });
});

describe("ссылки на каналы MAX из каталога заданий", () => {
  function channel(taskId: string, platform: "telegram" | "max" | "vk", url: string, patch: Partial<TaskDef> = {}): TaskDef {
    return {
      taskId,
      period: "achievement",
      kind: "channel",
      params: { platform, chat: "-100500", url },
      filter: null,
      tier: null,
      target: 1,
      title: null,
      coins: 0,
      gems: 15,
      shards: 0,
      passPoints: 0,
      sort: 0,
      active: true,
      limit: null,
      image: null,
      ...NO_ACHIEVEMENT_FIELDS,
      ...patch,
    };
  }

  const repository = (defs: TaskDef[]): Pick<TasksRepository, "catalog"> => ({ catalog: async () => defs });

  it("берёт адреса включённых заданий-каналов MAX в порядке каталога; чужие площадки, выключенные и другие виды — нет", async () => {
    const links = new MaxChannelLinks(
      repository([
        channel("tg_channel", "telegram", "https://t.me/rubezh"),
        channel("max_second", "max", "https://max.ru/join/second"),
        channel("max_off", "max", "https://max.ru/join/off", { active: false }),
        channel("vk_group", "vk", "https://vk.com/rubezh"),
        channel("max_link", "max", "https://max.ru/join/not-a-channel", { kind: "link" }),
        channel("max_first", "max", "https://max.ru/join/first"),
      ]),
    );

    await expect(links.urls()).resolves.toEqual(["https://max.ru/join/second", "https://max.ru/join/first"]);
  });

  it("один адрес у двух заданий — одна кнопка", async () => {
    const links = new MaxChannelLinks(repository([channel("a", "max", "https://max.ru/join/same"), channel("b", "max", "https://max.ru/join/same")]));

    await expect(links.urls()).resolves.toEqual(["https://max.ru/join/same"]);
  });

  it("заданий-каналов MAX нет — пустой список", async () => {
    await expect(new MaxChannelLinks(repository([channel("tg", "telegram", "https://t.me/rubezh")])).urls()).resolves.toEqual([]);
  });
});

describe("подписка вебхука у MAX", () => {
  interface Existing {
    url: string;
    updateTypes: readonly string[] | null;
  }

  let logged: string[];
  let existing: Existing[];
  let calls: { method: "subscriptions" | "subscribe"; args: unknown[] }[];
  let subscribeFailure: Error | null;
  let values: Record<string, string>;

  function service(env: Record<string, string> = {}): MaxSubscriptionService {
    const api = {
      subscriptions: async (): Promise<Existing[]> => {
        calls.push({ method: "subscriptions", args: [] });
        return existing;
      },
      subscribe: async (...args: unknown[]): Promise<void> => {
        calls.push({ method: "subscribe", args });
        if (subscribeFailure !== null) throw subscribeFailure;
      },
    };
    return new MaxSubscriptionService(api, secretsOf(values), config(env));
  }

  const subscribes = () => calls.filter((call) => call.method === "subscribe");

  beforeEach(() => {
    logged = [];
    existing = [];
    calls = [];
    subscribeFailure = null;
    values = { [SECRETS.maxBotToken.key]: TOKEN, [SECRETS.maxWebhookSecret.key]: SECRET };
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((line: unknown) => void logged.push(String(line)));
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("есть ключ, секрет и публичный адрес — подписка на адрес вебхука с секретом и типом `bot_started`", async () => {
    await expect(service().ensure()).resolves.toBe("subscribed");

    expect(subscribes()).toEqual([{ method: "subscribe", args: [WEBHOOK_URL, SECRET, ["bot_started"]] }]);
  });

  it("секрет с подчёркиванием уходит в MAX с дефисом: в описании поля разрешены латиница, цифры и дефис", async () => {
    values[SECRETS.maxWebhookSecret.key] = "aaaa_bbbb_cccc_dddd_eeee_ffff_gggg_hhhh";

    await service().ensure();

    expect(subscribes()[0]?.args[1]).toBe("aaaa-bbbb-cccc-dddd-eeee-ffff-gggg-hhhh");
  });

  it("та же подписка уже есть — второго вызова нет", async () => {
    existing = [{ url: WEBHOOK_URL, updateTypes: ["bot_started"] }];

    await expect(service().ensure()).resolves.toBe("present");

    expect(subscribes()).toEqual([]);
  });

  it("подписка на тот же адрес без `bot_started` — оформляется заново", async () => {
    existing = [{ url: WEBHOOK_URL, updateTypes: ["message_created"] }];

    await expect(service().ensure()).resolves.toBe("subscribed");

    expect(subscribes()).toHaveLength(1);
  });

  it("подписка на тот же адрес без списка типов (все события) — есть, ничего не делаем", async () => {
    existing = [{ url: WEBHOOK_URL, updateTypes: null }];

    await expect(service().ensure()).resolves.toBe("present");

    expect(subscribes()).toEqual([]);
  });

  it("у MAX подписка на другой адрес — оформляется наша, чужая не трогается", async () => {
    existing = [{ url: "https://other.example.test/hook", updateTypes: ["bot_started"] }];

    await expect(service().ensure()).resolves.toBe("subscribed");

    expect(subscribes()).toHaveLength(1);
  });

  it("повторный проход без перемен — ни запроса списка, ни второй подписки", async () => {
    const subscription = service();
    await subscription.ensure();
    calls.length = 0;

    await expect(subscription.ensure()).resolves.toBe("present");

    expect(calls).toEqual([]);
  });

  it("ключ бота сменили в панели — подписка оформляется заново, даже если адрес у MAX уже есть", async () => {
    const subscription = service();
    await subscription.ensure();
    existing = [{ url: WEBHOOK_URL, updateTypes: ["bot_started"] }];
    values[SECRETS.maxBotToken.key] = "second-token-from-panel-0123456789abcdefABCDEF";

    await expect(subscription.ensure()).resolves.toBe("subscribed");

    expect(subscribes()).toHaveLength(2);
  });

  it("секрет вебхука создан заново — подписка оформляется заново с новым секретом", async () => {
    const subscription = service();
    await subscription.ensure();
    existing = [{ url: WEBHOOK_URL, updateTypes: ["bot_started"] }];
    values[SECRETS.maxWebhookSecret.key] = "Zyx987-newSecretForMaxWebhook-9876543210";

    await expect(subscription.ensure()).resolves.toBe("subscribed");

    expect(subscribes()[1]?.args).toEqual([WEBHOOK_URL, "Zyx987-newSecretForMaxWebhook-9876543210", ["bot_started"]]);
  });

  it("нет ключа бота, нет секрета или нет публичного адреса — к MAX не ходим", async () => {
    delete values[SECRETS.maxBotToken.key];
    await expect(service().ensure()).resolves.toBe("skipped");

    values[SECRETS.maxBotToken.key] = TOKEN;
    delete values[SECRETS.maxWebhookSecret.key];
    await expect(service().ensure()).resolves.toBe("skipped");

    values[SECRETS.maxWebhookSecret.key] = SECRET;
    await expect(service({ PUBLIC_API_URL: "" }).ensure()).resolves.toBe("skipped");

    expect(calls).toEqual([]);
  });

  it("публичный адрес не https — MAX его не примет, подписку не оформляем", async () => {
    await expect(service({ PUBLIC_API_URL: "http://api.example.test" }).ensure()).resolves.toBe("skipped");

    expect(calls).toEqual([]);
  });

  it("адрес с косой чертой на конце не даёт двойной", async () => {
    await service({ PUBLIC_API_URL: `${PUBLIC_API}/` }).ensure();

    expect(subscribes()[0]?.args[0]).toBe(WEBHOOK_URL);
  });

  it("MAX отказал — не бросает, в лог без ключа и секрета; следующий проход пробует снова", async () => {
    const subscription = service();
    subscribeFailure = new Error("MAX POST /subscriptions: 500");

    await expect(subscription.ensure()).resolves.toBe("failed");

    expect(logged.join("\n")).toContain("max_subscribe_failed");
    expect(logged.join("\n")).not.toContain(TOKEN);
    expect(logged.join("\n")).not.toContain(SECRET);

    subscribeFailure = null;
    await expect(subscription.ensure()).resolves.toBe("subscribed");
    expect(subscribes()).toHaveLength(2);
  });

  it("список подписок не получен — тоже не бросает: старт сервера MAX не ломает", async () => {
    const api = {
      subscriptions: async (): Promise<Existing[]> => {
        throw new Error("MAX GET /subscriptions: 503");
      },
      subscribe: async (): Promise<void> => undefined,
    };

    await expect(new MaxSubscriptionService(api, secretsOf(values), config()).ensure()).resolves.toBe("failed");
  });
});
