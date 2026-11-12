import "reflect-metadata";
import { Logger, Module, type Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import type { ConsumeOutcome } from "../src/modules/external-identity/external-identity-rules.js";
import type { ExternalIdentityService } from "../src/modules/external-identity/external-identity.service.js";
import { SECRETS, VK_API_VERSION, VK_CALLBACK_PATH, type SecretDefinition } from "../src/modules/secrets/secret-catalog.js";
import type { SecretsReader } from "../src/modules/secrets/secrets.service.js";
import { SETTINGS, type SettingDefinition } from "../src/modules/settings/setting-catalog.js";
import type { SettingsReader } from "../src/modules/settings/settings.service.js";
import { VkApi } from "../src/platforms/vk/vk-api.js";
import { VkCallbackController } from "../src/platforms/vk/vk-callback.controller.js";
import { VkCommunity } from "../src/platforms/vk/vk-community.js";
import type { VkMessageEvent } from "../src/platforms/vk/vk-events.js";
import { VkEventQueue } from "../src/platforms/vk/vk-event-queue.js";
import { VkUpdatesWorker } from "../src/platforms/vk/vk-updates.worker.js";
import { redisDatabase } from "./helpers/redis-database.js";

/**
 * Сообщество VK как бот (docs/35-stage4-plan.md Р188, tasks/T-0378): вебхук
 * Callback API — секрет, подтверждение сервера, события через очередь — и
 * воркер, который связывает аккаунт по коду из `ref` и отвечает игроку.
 */

const TOKEN = "vk1.a.TestCommunityTokenWithEnoughSymbols0123456789";
const SECRET = "aBcD3fGh1jKlMn0pQrStUvWxYz0123456789";
const CONFIRMATION = "a1b2c3d4";
const GROUP_ID = 123456;
const CODE = "AbCd1234AbCd1234";
const COMMUNITY_URL = "https://vk.com/rubezh_game";

interface Values {
  token: string | null;
  secret: string | null;
  confirmation: string | null;
  community: string;
}

const DEFAULTS: Values = { token: TOKEN, secret: SECRET, confirmation: CONFIRMATION, community: "club123456" };

function communityOf(values: Values): VkCommunity {
  const secrets: SecretsReader = {
    get: (secret: SecretDefinition) => {
      if (secret.key === SECRETS.vkCommunityToken.key) return values.token;
      if (secret.key === SECRETS.vkCallbackSecret.key) return values.secret;
      if (secret.key === SECRETS.vkCallbackConfirmation.key) return values.confirmation;
      return null;
    },
  };
  const settings = {
    get: (setting: SettingDefinition) => (setting.key === SETTINGS.vkCommunity.key ? values.community : setting.fallback),
  } as unknown as Pick<SettingsReader, "get">;
  return new VkCommunity(secrets, settings);
}

/** Подмена `Queue.add` BullMQ с тем же правилом, что у настоящего: повтор id задания второго задания не заводит. */
class FakeBull {
  readonly jobs = new Map<string, { name: string; data: unknown }>();
  readonly all: { name: string; data: unknown; options: Record<string, unknown> }[] = [];
  failWith: Error | null = null;

  async add(name: string, data: unknown, options: Record<string, unknown>): Promise<void> {
    if (this.failWith !== null) throw this.failWith;
    this.all.push({ name, data, options });
    const id = typeof options.jobId === "string" ? options.jobId : `auto-${String(this.all.length)}`;
    if (!this.jobs.has(id)) this.jobs.set(id, { name, data });
  }
}

// Строки лога модулей в вывод тестов не попадают.
beforeEach(() => {
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("вебхук сообщества VK", () => {
  let app: NestFastifyApplication | null = null;
  let bull: FakeBull;
  let resolved: string[];

  async function start(patch: Partial<Values> = {}): Promise<NestFastifyApplication> {
    bull = new FakeBull();
    resolved = [];
    const values = { ...DEFAULTS, ...patch };
    const queue = new VkEventQueue(loadAppConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), {} as unknown as VkUpdatesWorker);
    Object.assign(queue as unknown as { queue: unknown }, { queue: bull });
    const api = {
      groupId: async (name: string) => {
        resolved.push(name);
        return name === "rubezh_game" ? String(GROUP_ID) : "999";
      },
    } as unknown as VkApi;
    @Module({
      controllers: [VkCallbackController],
      providers: [
        { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv) },
        { provide: VkCommunity, useValue: communityOf(values) },
        { provide: VkEventQueue, useValue: queue },
        { provide: VkApi, useValue: api },
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule as Type<unknown>, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  }

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  function post(target: NestFastifyApplication, body: unknown) {
    return target.inject({ method: "POST", url: VK_CALLBACK_PATH, payload: body as object });
  }

  function messageNew(patch: Record<string, unknown> = {}, message: Record<string, unknown> = {}) {
    return {
      type: "message_new",
      group_id: GROUP_ID,
      event_id: "evt-0001",
      v: VK_API_VERSION,
      secret: SECRET,
      object: { message: { id: 1, from_id: 555000111, peer_id: 555000111, text: "Начать", ref: CODE, ref_source: "link", ...message }, client_info: { button_actions: [] } },
      ...patch,
    };
  }

  it("адрес вебхука — тот, что показывает панель для кабинета VK", async () => {
    expect(VK_CALLBACK_PATH).toBe("/api/v1/vk/callback");
    const target = await start();
    const response = await post(target, messageNew());
    expect(response.statusCode).not.toBe(404);
  });

  describe("выключено", () => {
    it("нет ключа сообщества — 404, в очередь ничего не попало", async () => {
      const target = await start({ token: null });
      for (const body of [messageNew(), { type: "confirmation", group_id: GROUP_ID, secret: SECRET }]) {
        expect((await post(target, body)).statusCode).toBe(404);
      }
      expect(bull.all).toEqual([]);
    });

    it("нет секрета Callback API — 404", async () => {
      const target = await start({ secret: null });
      expect((await post(target, messageNew())).statusCode).toBe(404);
      expect(bull.all).toEqual([]);
    });
  });

  describe("секрет", () => {
    it("неверный secret — 401, в очередь ничего не попало", async () => {
      const target = await start();
      const response = await post(target, messageNew({ secret: `${SECRET}x` }));
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toBe("ok");
      expect(bull.all).toEqual([]);
    });

    it("нет secret или он не строка — 401", async () => {
      const target = await start();
      expect((await post(target, messageNew({ secret: undefined }))).statusCode).toBe(401);
      expect((await post(target, messageNew({ secret: 12345 }))).statusCode).toBe(401);
      expect((await post(target, messageNew({ secret: null }))).statusCode).toBe(401);
      expect(bull.all).toEqual([]);
    });

    it("секрет другой длины — 401 без исключения (не 500)", async () => {
      const target = await start();
      for (const secret of ["", "x", SECRET.slice(1), `${SECRET}${SECRET}`]) {
        expect((await post(target, messageNew({ secret }))).statusCode, `«${secret}»`).toBe(401);
      }
      expect(bull.all).toEqual([]);
    });

    it("с неверным secret тело дальше не разбирается: даже непонятное тело — 401, а не 400", async () => {
      const target = await start();
      expect((await post(target, { secret: "wrong", type: 42 })).statusCode).toBe(401);
      expect((await post(target, [1, 2, 3])).statusCode).toBe(401);
    });

    it("верный secret, но тело не похоже на событие — 400", async () => {
      const target = await start();
      expect((await post(target, { secret: SECRET })).statusCode).toBe(400);
      expect((await post(target, { secret: SECRET, type: "message_new", group_id: "не число" })).statusCode).toBe(400);
      expect(bull.all).toEqual([]);
    });
  });

  describe("подтверждение сервера", () => {
    it("своё сообщество — тело ровно строка подтверждения, text/plain", async () => {
      const target = await start();
      const response = await post(target, { type: "confirmation", group_id: GROUP_ID, secret: SECRET });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(CONFIRMATION);
      expect(String(response.headers["content-type"])).toMatch(/^text\/plain/);
    });

    it("чужое сообщество — 401, строку не отдаём", async () => {
      const target = await start();
      const response = await post(target, { type: "confirmation", group_id: GROUP_ID + 1, secret: SECRET });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain(CONFIRMATION);
    });

    it("сообщество в настройке задано коротким именем: его числовой id спрашивается у VK", async () => {
      const target = await start({ community: "https://vk.com/rubezh_game" });
      const own = await post(target, { type: "confirmation", group_id: GROUP_ID, secret: SECRET });
      expect(own.body).toBe(CONFIRMATION);
      expect(resolved).toEqual(["rubezh_game"]);
      expect((await post(target, { type: "confirmation", group_id: 1, secret: SECRET })).statusCode).toBe(401);
    });

    it("настройки сообщества или строки подтверждения нет — 404: отвечать нечем", async () => {
      expect((await post(await start({ community: "" }), { type: "confirmation", group_id: GROUP_ID, secret: SECRET })).statusCode).toBe(404);
      await app?.close();
      expect((await post(await start({ confirmation: null }), { type: "confirmation", group_id: GROUP_ID, secret: SECRET })).statusCode).toBe(404);
    });
  });

  describe("новое сообщение", () => {
    it("`ok` текстом, событие в очереди — только нужное: код, id игрока и id события", async () => {
      const target = await start();
      const response = await post(target, messageNew());
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("ok");
      expect(String(response.headers["content-type"])).toMatch(/^text\/plain/);
      expect(bull.all).toHaveLength(1);
      expect(bull.all[0]?.data).toEqual({ eventId: "evt-0001", groupId: GROUP_ID, fromId: 555000111, ref: CODE });
      // Текст сообщения игрока в Redis не уходит.
      expect(JSON.stringify(bull.all[0]?.data)).not.toContain("Начать");
    });

    it("сообщение без ref — тоже в очередь: воркер подскажет, что делать", async () => {
      const target = await start();
      await post(target, messageNew({}, { ref: undefined }));
      expect(bull.all[0]?.data).toMatchObject({ ref: null });
    });

    it("тот же event_id дважды — в очереди одно: VK повторяет доставку, пока не получит ok", async () => {
      const target = await start();
      expect((await post(target, messageNew())).body).toBe("ok");
      expect((await post(target, messageNew())).body).toBe("ok");
      expect((await post(target, messageNew({ event_id: "evt-0002" }))).body).toBe("ok");
      expect(bull.jobs.size).toBe(2);
      expect([...bull.jobs.keys()].sort()).toEqual(["vk-evt-0001", "vk-evt-0002"]);
    });

    it("Redis недоступен — 503, VK повторит; текст сбоя наружу не уходит", async () => {
      const target = await start();
      bull.failWith = new Error("Redis недоступен: connect ECONNREFUSED 10.0.0.5:6379");
      const response = await post(target, messageNew());
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("ECONNREFUSED");
      expect(response.body).not.toBe("ok");
    });

    it("сообщение не от человека (from_id отрицательный — сообщество) и без сообщения — ok, но в очередь не идёт", async () => {
      const target = await start();
      expect((await post(target, messageNew({}, { from_id: -123456 }))).body).toBe("ok");
      expect((await post(target, messageNew({ object: {} }))).body).toBe("ok");
      expect((await post(target, messageNew({ object: undefined }))).body).toBe("ok");
      expect(bull.all).toEqual([]);
    });
  });

  it("прочие события — ok без разбора", async () => {
    const target = await start();
    for (const type of ["message_reply", "wall_post_new", "group_join", "message_allow"]) {
      const response = await post(target, { type, group_id: GROUP_ID, event_id: `e-${type}`, secret: SECRET, object: { anything: true } });
      expect(response.statusCode, type).toBe(200);
      expect(response.body, type).toBe("ok");
    }
    expect(bull.all).toEqual([]);
  });
});

describe("воркер сообщества VK", () => {
  const FROM = 555000111;

  function event(ref: string | null = CODE): VkMessageEvent {
    return { eventId: "evt-1", groupId: GROUP_ID, fromId: FROM, ref };
  }

  function setup(consume: (platform: string, code: string, externalUserId: string) => Promise<ConsumeOutcome>, community = COMMUNITY_URL) {
    const consumed: [string, string, string][] = [];
    const sent: { userId: string; text: string; keyboard: unknown }[] = [];
    const identity = {
      consume: async (platform: string, code: string, externalUserId: string) => {
        consumed.push([platform, code, externalUserId]);
        return await consume(platform, code, externalUserId);
      },
    } as unknown as ExternalIdentityService;
    const api = {
      failSend: false,
      sendMessage: async function (this: { failSend: boolean }, userId: string, text: string, keyboard?: unknown) {
        if (this.failSend) throw new Error("VK недоступен");
        sent.push({ userId, text, keyboard });
      },
    };
    const worker = new VkUpdatesWorker(identity, api as unknown as VkApi, communityOf({ ...DEFAULTS, community }));
    return { worker, consumed, sent, api };
  }

  const BUTTON = { inline: true, buttons: [[{ action: { type: "open_link", link: COMMUNITY_URL, label: "Перейти в сообщество" } }]] };

  it("ref с действующим кодом: consume с `vk` и from_id строкой, ответ «Готово!» со ссылкой отдельной строкой и кнопкой", async () => {
    const { worker, consumed, sent } = setup(async () => "linked");
    await worker.handle(event());
    expect(consumed).toEqual([["vk", CODE, String(FROM)]]);
    expect(sent).toEqual([
      {
        userId: String(FROM),
        text: `Готово! Аккаунт VK связан с игрой. Вступи в сообщество и вернись в игру — нажми «Проверить».\n${COMMUNITY_URL}`,
        keyboard: BUTTON,
      },
    ]);
  });

  it("аккаунт уже связан — свой текст со ссылкой", async () => {
    const { worker, sent } = setup(async () => "already");
    await worker.handle(event());
    expect(sent).toEqual([{ userId: String(FROM), text: `Аккаунт уже связан. Вступи в сообщество и нажми «Проверить» в игре.\n${COMMUNITY_URL}`, keyboard: BUTTON }]);
  });

  it("этот VK связан с другим игроком — свой текст, без ссылки и кнопки", async () => {
    const { worker, sent } = setup(async () => "taken");
    await worker.handle(event());
    expect(sent).toEqual([{ userId: String(FROM), text: "Этот аккаунт VK уже связан с другим игроком. Связать его второй раз нельзя.", keyboard: undefined }]);
  });

  it("код устарел или чужой — свой текст", async () => {
    const { worker, sent } = setup(async () => "expired");
    await worker.handle(event());
    expect(sent).toEqual([{ userId: String(FROM), text: "Ссылка устарела. Открой задание в игре и нажми «Открыть сообщество VK» ещё раз.", keyboard: undefined }]);
  });

  it("без ref — подсказка, связь не трогаем", async () => {
    const { worker, consumed, sent } = setup(async () => "linked");
    await worker.handle(event(null));
    expect(consumed).toEqual([]);
    expect(sent).toEqual([{ userId: String(FROM), text: "Чтобы связать аккаунт, открой задание в игре и нажми «Открыть сообщество VK»", keyboard: undefined }]);
  });

  it("сообщество в настройке задано именем — ссылка строится от него", async () => {
    const { worker, sent } = setup(async () => "linked", "club123456");
    await worker.handle(event());
    expect(sent[0]?.text.endsWith("\nhttps://vk.com/club123456")).toBe(true);
  });

  it("сообщество в настройке не задано — ответ без ссылки и без кнопки, связь всё равно записана", async () => {
    const { worker, consumed, sent } = setup(async () => "linked", "");
    await worker.handle(event());
    expect(consumed).toHaveLength(1);
    expect(sent[0]?.text).toBe("Готово! Аккаунт VK связан с игрой. Вступи в сообщество и вернись в игру — нажми «Проверить».");
    expect(sent[0]?.keyboard).toBeUndefined();
  });

  it("ответ не отправился — лог, без исключения и без повтора: связь уже записана", async () => {
    const { worker, consumed, api } = setup(async () => "linked");
    api.failSend = true;
    await expect(worker.handle(event())).resolves.toBeUndefined();
    expect(consumed).toHaveLength(1);
  });

  it("consume упал (база недоступна) — исключение: очередь повторит, связь ещё не записана", async () => {
    const { worker, sent } = setup(async () => {
      throw new Error("база недоступна");
    });
    await expect(worker.handle(event())).rejects.toThrow("база недоступна");
    expect(sent).toEqual([]);
  });

  it("задание очереди: повреждённые данные отбрасываются, настоящие доходят до воркера", async () => {
    const handled: VkMessageEvent[] = [];
    const queue = new VkEventQueue(loadAppConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), { handle: async (incoming: VkMessageEvent) => void handled.push(incoming) } as unknown as VkUpdatesWorker);
    await queue.process({ data: { eventId: 1 }, attemptsMade: 0 });
    await queue.process({ data: null, attemptsMade: 0 });
    expect(handled).toEqual([]);
    await queue.process({ data: event(), attemptsMade: 0 });
    expect(handled).toEqual([event()]);
  });
});

describe("ключи сообщества VK в каталоге", () => {
  it("секрет Callback API создаёт сервер: латиница и цифры, 32–64 знака, разный каждый раз", () => {
    const generated = SECRETS.vkCallbackSecret.generated;
    expect(generated).toBeDefined();
    const first = generated?.generate?.() ?? "";
    const second = generated?.generate?.() ?? "";
    expect(first).toMatch(/^[A-Za-z0-9]{32,64}$/);
    expect(SECRETS.vkCallbackSecret.pattern.test(first)).toBe(true);
    expect(second).not.toBe(first);
  });

  it("панель показывает адрес вебхука и секрет; без PUBLIC_API_URL — путь", () => {
    const generated = SECRETS.vkCallbackSecret.generated;
    const withBase = loadAppConfig({ NODE_ENV: "test", PUBLIC_API_URL: "https://api.example.test/" } as NodeJS.ProcessEnv);
    const without = loadAppConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const shown = generated?.reveal(SECRET, withBase) ?? "";
    expect(shown).toContain("https://api.example.test/api/v1/vk/callback");
    expect(shown).toContain(SECRET);
    expect(generated?.reveal(SECRET, without)).toContain("/api/v1/vk/callback");
    expect(generated?.where).toContain("Callback API");
    // Тот же путь, что у маршрута контроллера: панель не покажет адрес, по которому ничего нет.
    expect(VK_CALLBACK_PATH).toBe("/api/v1/vk/callback");
  });

  it("все три ключа — сервис «VK», ключ сообщества и строка подтверждения только из панели", () => {
    for (const secret of [SECRETS.vkCommunityToken, SECRETS.vkCallbackSecret, SECRETS.vkCallbackConfirmation]) {
      expect(secret.service).toContain("VK");
      expect(secret.fromEnv(loadAppConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv))).toBeNull();
    }
    expect(SECRETS.vkCommunityToken.key).toBe("vk.community-token");
    expect(SECRETS.vkCallbackSecret.key).toBe("vk.callback-secret");
    expect(SECRETS.vkCallbackConfirmation.key).toBe("vk.callback-confirmation");
    expect(SECRETS.vkCommunityToken.cabinetUrl).toBe("https://vk.com/groups?tab=admin");
  });

  describe("проверка ключа сообщества: groups.getById", () => {
    const check = SECRETS.vkCommunityToken.check;

    function fakeFetch(response: () => Response) {
      const calls: { url: string; init: RequestInit }[] = [];
      const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return response();
      }) as typeof fetch;
      return { calls, impl };
    }

    it("VK принял ключ — ok; ключ в теле, а не в адресе", async () => {
      const { calls, impl } = fakeFetch(() => Response.json({ response: { groups: [{ id: GROUP_ID, name: "Рубеж" }] } }));
      const result = await check?.(TOKEN, impl);
      expect(result).toMatchObject({ ok: true });
      expect(calls[0]?.url).toBe("https://api.vk.com/method/groups.getById");
      expect(calls[0]?.url).not.toContain(TOKEN);
      expect(String(calls[0]?.init.body)).toContain(`access_token=${TOKEN}`);
    });

    it("VK ответил ошибкой в теле (HTTP 200) — не ok, ключ в сообщении не светится", async () => {
      const { impl } = fakeFetch(() => Response.json({ error: { error_code: 5, error_msg: "User authorization failed: invalid access_token (4)." } }));
      const result = await check?.(TOKEN, impl);
      expect(result?.ok).toBe(false);
      expect(result?.message).toContain("VK");
      expect(result?.message).not.toContain(TOKEN);
    });

    it("5xx и обрыв сети — не ok, «ключ не проверен»", async () => {
      const server = await check?.(TOKEN, fakeFetch(() => new Response("", { status: 502 })).impl);
      expect(server).toMatchObject({ ok: false, message: expect.stringContaining("не проверен") });
      const network = await check?.(
        TOKEN,
        (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
      );
      expect(network).toMatchObject({ ok: false, message: expect.stringContaining("не проверен") });
    });
  });
});

// Сквозной: настоящие BullMQ и Redis. Показывает то, чего подмены не покажут:
// повтор event_id не заводит второе задание, а событие доходит до воркера.
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 7);

describe.skipIf(REDIS_URL === "")("очередь событий VK на живом Redis", () => {
  let queue: VkEventQueue | null = null;

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

  it("событие доходит до воркера, а повтор event_id обрабатывается один раз", async () => {
    const seen: string[] = [];
    const worker = { handle: async (incoming: VkMessageEvent) => void seen.push(incoming.eventId ?? "") } as unknown as VkUpdatesWorker;
    const live = new VkEventQueue(loadAppConfig({ NODE_ENV: "test", REDIS_URL } as NodeJS.ProcessEnv), worker);
    await live.onApplicationBootstrap();
    queue = live;
    const id = `live-${String(Date.now())}-${String(Math.floor(Math.random() * 1_000_000))}`;

    await live.enqueue({ eventId: id, groupId: GROUP_ID, fromId: 1, ref: CODE });
    await live.enqueue({ eventId: id, groupId: GROUP_ID, fromId: 1, ref: CODE });
    await live.enqueue({ eventId: `${id}-b`, groupId: GROUP_ID, fromId: 1, ref: null });
    await until(() => seen.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(seen.sort()).toEqual([id, `${id}-b`]);
  }, 20_000);
});
