import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrisma } from "../src/infra/database.js";
import { closeRedis, createRedis } from "../src/infra/redis.js";
import { PrismaAccountRepository } from "../src/modules/auth/account.repository.js";
import { BotCardKinds, type BotCardKind } from "../src/modules/bot-cards/bot-card-kinds.js";
import { PrismaBotCardsRepository, type NewBotCard } from "../src/modules/bot-cards/bot-cards.repository.js";
import { BotCardsService } from "../src/modules/bot-cards/bot-cards.service.js";
import { BotMessages } from "../src/modules/bot-messages/bot-messages.service.js";
import { BotNotifyQueue } from "../src/modules/notifications-bot/bot-notify-queue.js";
import type { SettingDefinition } from "../src/modules/settings/setting-catalog.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { LiveCards, type LiveCardMessage, type LiveCardPort, type LiveCardRef, type LiveCardSendOutcome, type LiveCardUpdateOutcome } from "../src/platforms/ports/live-card.js";
import { Messengers, type Messenger } from "../src/platforms/ports/messenger.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { uniquePlatformUserId } from "./helpers/player-ids.js";
import { redisDatabase } from "./helpers/redis-database.js";
import { retryOnConflict } from "./helpers/retry-conflict.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Живые карточки бота на живых Postgres и Redis (docs/17-testing-strategy.md §4.2;
 * tasks/T-0395). Адреса — TEST_DATABASE_URL и PLAYTEST_TEST_REDIS_URL, без них пропуск.
 *
 * Память этого не покажет: «живая — одна на вид» держит частичный уникальный
 * индекс, а не проверка перед вставкой; гонку двух вставок решает база; а
 * «одно задание на id, пока оно не выполнено» — это поведение BullMQ, а не наше.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 10);
const live = DATABASE_URL !== "" && REDIS_URL !== "";

const MIN = 60_000;
const T0 = new Date(Date.UTC(2026, 10, 15, 9, 0));

const KIND_ENABLED: SettingDefinition<boolean> = {
  key: "bot.widget.itest.enabled",
  group: "Сообщения бота",
  title: "тест",
  hint: "тест",
  kind: "boolean",
  schema: z.boolean(),
  fromEnv: () => null,
  fallback: true,
};

/** Бот, которому нечего писать: карточка идёт через порт, запасное сообщение в этих кейсах не нужно. */
const IDLE_MESSENGER: Messenger = { platform: "telegram", configured: true, ratePerSec: 25, send: async () => ({ status: "sent" }) };

class RecordingPort implements LiveCardPort {
  readonly platform = "telegram" as const;
  readonly configured = true;
  readonly sends: LiveCardMessage[] = [];
  private messageIds = 0;

  supports(): boolean {
    return true;
  }

  async send(platformUserId: string, message: LiveCardMessage): Promise<LiveCardSendOutcome> {
    this.sends.push(message);
    this.messageIds++;
    return { status: "sent", ref: { chatId: platformUserId, messageId: this.messageIds }, version: "ab12cd34" };
  }

  async update(_ref: LiveCardRef, _state: string): Promise<LiveCardUpdateOutcome> {
    return { status: "edited" };
  }
}

function newCard(accountId: string, overrides: Partial<NewBotCard> = {}): NewBotCard {
  return {
    accountId,
    platform: "telegram",
    kind: "season",
    chatId: "100",
    messageId: Math.floor(Math.random() * 1_000_000_000),
    version: "ab12cd34",
    periodKey: "2026-W46",
    state: '{"v":1}',
    stateHash: "h".repeat(64),
    at: T0,
    ...overrides,
  };
}

describe.skipIf(!live)("живые карточки бота на живых Postgres и Redis", () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let redis: Redis;
  let accounts: PrismaAccountRepository;
  let repository: PrismaBotCardsRepository;
  const created: string[] = [];
  const lockKeys: string[] = [];

  beforeAll(async () => {
    config = loadAppConfig({ NODE_ENV: "test", DATABASE_URL, REDIS_URL, JWT_ACCESS_SECRET: AUTH_ENV.JWT_ACCESS_SECRET, TELEGRAM_BOT_TOKEN: AUTH_ENV.TELEGRAM_BOT_TOKEN } as NodeJS.ProcessEnv);
    prisma = createPrisma(config);
    redis = createRedis(config);
    await redis.connect();
    accounts = new PrismaAccountRepository(prisma);
    repository = new PrismaBotCardsRepository(prisma);
  });

  afterAll(async () => {
    if (lockKeys.length > 0) await redis.del(...lockKeys);
    // Строки таблицы уходят каскадом вместе с аккаунтом.
    for (let start = 0; start < created.length; start += 200) {
      const chunk = created.slice(start, start + 200);
      await retryOnConflict(() => prisma.account.deleteMany({ where: { accountId: { in: chunk } } }));
    }
    await prisma.$disconnect();
    await closeRedis(redis);
  });

  async function player(): Promise<{ accountId: string; platformUserId: string }> {
    const account = await accounts.upsert({ platform: "telegram", platformUserId: uniquePlatformUserId(), displayName: "Карточка", username: null, photoUrl: null }, Date.now());
    created.push(account.accountId);
    return { accountId: account.accountId, platformUserId: account.platformUserId };
  }

  const liveRows = (accountId: string, kind = "season") => prisma.botCard.findMany({ where: { accountId, kind, closedAt: null } });

  describe("таблица bot_card", () => {
    it("частичный уникальный индекс: вторая живая строка того же аккаунта и вида — отказ; закрытая или другого вида — можно", async () => {
      const { accountId } = await player();
      const base = { accountId, platform: "telegram", chatId: "100", version: "ab12cd34", state: '{"v":1}', stateHash: "h", updatedAt: T0 };
      await prisma.botCard.create({ data: { ...base, kind: "season", messageId: 1 } });
      await expect(prisma.botCard.create({ data: { ...base, kind: "season", messageId: 2 } })).rejects.toThrow();
      await prisma.botCard.create({ data: { ...base, kind: "season", messageId: 3, closedAt: T0 } });
      await prisma.botCard.create({ data: { ...base, kind: "season", messageId: 4, closedAt: T0 } });
      await prisma.botCard.create({ data: { ...base, kind: "daily", messageId: 5 } });
      expect(await liveRows(accountId)).toHaveLength(1);
      expect(await prisma.botCard.count({ where: { accountId } })).toBe(4);
    });

    it("openReplacing закрывает прежнюю живую и вставляет новую в одной транзакции; id прежней — в ответе", async () => {
      const { accountId } = await player();
      const first = await repository.openReplacing(newCard(accountId, { messageId: 11 }));
      expect(first).toMatchObject({ status: "opened", replacedId: null });
      const second = await repository.openReplacing(newCard(accountId, { messageId: 12, at: new Date(T0.getTime() + MIN) }));
      expect(second.status).toBe("opened");
      if (first.status !== "opened" || second.status !== "opened") throw new Error("карточки не открылись");
      expect(second.replacedId).toBe(first.id);

      const rows = await prisma.botCard.findMany({ where: { accountId }, orderBy: { messageId: "asc" } });
      expect(rows.map((row) => [row.messageId, row.closedAt?.getTime() ?? null])).toEqual([
        [11, T0.getTime() + MIN],
        [12, null],
      ]);
      expect((await repository.live(accountId, "season"))?.id).toBe(second.id);
    });

    it("вставка проиграла гонку (живая появилась, пока шла транзакция) — строка закрыта сразу, живая остаётся одна", async () => {
      const { accountId } = await player();
      // Соседняя транзакция вставила живую строку, но ещё не зафиксировала её: UPDATE нашего вызова её не видит,
      // а вставка упирается в уникальный индекс и ждёт её исхода.
      const holder = prisma.$transaction(async (tx) => {
        await tx.botCard.create({ data: { accountId, platform: "telegram", kind: "season", chatId: "100", messageId: 21, version: "v", state: '{"v":1}', stateHash: "h", updatedAt: T0 } });
        await new Promise((resolve) => setTimeout(resolve, 400));
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const lost = await repository.openReplacing(newCard(accountId, { messageId: 22 }));
      await holder;

      expect(lost.status).toBe("raced");
      const rows = await prisma.botCard.findMany({ where: { accountId }, orderBy: { messageId: "asc" } });
      expect(rows.map((row) => [row.messageId, row.closedAt !== null])).toEqual([
        [21, false],
        [22, true],
      ]);
    });

    it("параллельные вставки одного вида — в базе одна живая строка, остальные закрыты", async () => {
      const { accountId } = await player();
      const results = await Promise.all(Array.from({ length: 6 }, (_, index) => repository.openReplacing(newCard(accountId, { messageId: 30 + index }))));
      expect(results.every((result) => result.status === "opened" || result.status === "raced")).toBe(true);
      expect(await liveRows(accountId)).toHaveLength(1);
      expect(await prisma.botCard.count({ where: { accountId } })).toBe(6);
    });

    it("touched и close — только для живой строки: закрытую правка не воскрешает, повторное закрытие ничего не меняет", async () => {
      const { accountId } = await player();
      const opened = await repository.openReplacing(newCard(accountId, { messageId: 41 }));
      if (opened.status !== "opened") throw new Error("карточка не открылась");
      const later = new Date(T0.getTime() + 5 * MIN);
      expect(await repository.touched(opened.id, '{"v":1,"a":1}', "x".repeat(64), later)).toBe(true);
      expect(await repository.byId(opened.id)).toMatchObject({ state: '{"v":1,"a":1}', stateHash: "x".repeat(64), updatedAt: later, closedAt: null });
      expect(await repository.close(opened.id, later)).toBe(true);
      expect(await repository.close(opened.id, new Date(later.getTime() + MIN))).toBe(false);
      expect((await repository.byId(opened.id))?.closedAt).toEqual(later);
      expect(await repository.touched(opened.id, '{"v":1,"a":2}', "y".repeat(64), later)).toBe(false);
      expect((await repository.byId(opened.id))?.state).toBe('{"v":1,"a":1}');
    });

    it("byMessage находит карточку по площадке, чату и сообщению; чужой чат и неизвестное сообщение — null", async () => {
      const { accountId } = await player();
      const chatId = String(Math.floor(Math.random() * 1_000_000_000_000));
      const opened = await repository.openReplacing(newCard(accountId, { chatId, messageId: 51 }));
      if (opened.status !== "opened") throw new Error("карточка не открылась");
      expect((await repository.byMessage("telegram", chatId, 51))?.id).toBe(opened.id);
      expect(await repository.byMessage("telegram", chatId, 52)).toBeNull();
      expect(await repository.byMessage("telegram", `${chatId}0`, 51)).toBeNull();
      expect(await repository.byMessage("max", chatId, 51)).toBeNull();
    });

    it("dueForFinal: только живые этого вида с другим периодом — закрытые, чужого вида и текущего периода не попадают", async () => {
      const kind = "itest_final";
      const { accountId } = await player();
      const other = await player();
      const third = await player();
      const fourth = await player();
      await repository.openReplacing(newCard(accountId, { kind, periodKey: "P1", messageId: 61 }));
      await repository.openReplacing(newCard(other.accountId, { kind, periodKey: "P2", messageId: 62 }));
      const closed = await repository.openReplacing(newCard(third.accountId, { kind, periodKey: "P1", messageId: 63 }));
      if (closed.status !== "opened") throw new Error("карточка не открылась");
      await repository.close(closed.id, T0);
      await repository.openReplacing(newCard(fourth.accountId, { kind: "itest_other", periodKey: "P1", messageId: 64 }));

      const due = (await repository.dueForFinal(kind, "P2", 500)).filter((row) => [accountId, other.accountId, third.accountId, fourth.accountId].includes(row.accountId));
      expect(due.map((row) => row.messageId)).toEqual([61]);
      const limited = await repository.dueForFinal(kind, "P2", 1);
      expect(limited.length).toBeLessThanOrEqual(1);
    });

    it("состояние хранится строкой как есть: кириллица и порядок полей не меняются", async () => {
      const { accountId } = await player();
      const state = '{"v":1,"название":"Сезон","place":3}';
      const opened = await repository.openReplacing(newCard(accountId, { state, messageId: 71 }));
      if (opened.status !== "opened") throw new Error("карточка не открылась");
      expect((await repository.byId(opened.id))?.state).toBe(state);
    });

    it("аккаунт удалён — его карточки уходят каскадом", async () => {
      const { accountId } = await player();
      await repository.openReplacing(newCard(accountId, { messageId: 81 }));
      await prisma.account.delete({ where: { accountId } });
      expect(await prisma.botCard.count({ where: { accountId } })).toBe(0);
    });
  });

  describe("отправка при гонке двух вызовов", () => {
    function serviceWith(port: RecordingPort) {
      const panel = panelSettings({ "bot.formats.enabled": true, "bot.widget.enabled": true });
      const kind: BotCardKind = {
        kind: "season",
        enabled: KIND_ENABLED,
        choice: null,
        startRef: "n-season_card",
        periodKey: () => "2026-W46",
        state: async () => ({ place: 3 }),
        caption: () => "Сезон",
        fallback: () => ({ blocks: [{ kind: "paragraph", text: "Сезон" }] }),
        actions: [],
      };
      const kinds = new BotCardKinds();
      kinds.register(kind);
      const jobs: string[] = [];
      return new BotCardsService(
        panel,
        accounts,
        new Messengers([IDLE_MESSENGER]),
        new LiveCards([port]),
        new AppLinks([{ platform: "telegram", launch: (param) => `https://t.me/rubezh_bot/play?startapp=${param}`, chat: () => null }]),
        { state: async () => ({ canMessage: true, reason: "entered", changedAt: T0 }), platformChanged: async () => undefined },
        { valueOf: async () => undefined },
        { decide: async () => ({ action: "send", silent: false }) },
        new BotMessages(panel),
        { sent: async () => undefined },
        kinds,
        repository,
        {
          registerPaced: () => undefined,
          addPaced: async (name: string) => {
            jobs.push(name);
            return true;
          },
        } as unknown as BotNotifyQueue,
        redis,
      );
    }

    it("два параллельных send — в базе одна живая карточка: лок отвечает busy, а при проигранном локе решает индекс", async () => {
      const { accountId } = await player();
      lockKeys.push(`bot-cards:send:${accountId}:season`);
      const port = new RecordingPort();
      const service = serviceWith(port);
      const results = await Promise.all([service.send({ accountId, kind: "season", origin: "reply" }, T0), service.send({ accountId, kind: "season", origin: "reply" }, T0)]);

      expect(results).toContain("sent");
      expect(results.every((result) => result === "sent" || result === "busy")).toBe(true);
      expect(await liveRows(accountId)).toHaveLength(1);
      expect(port.sends).toHaveLength(results.filter((result) => result === "sent").length);
      // Лок снят: следующая отправка проходит и переносит прежнюю карточку.
      expect(await service.send({ accountId, kind: "season", origin: "reply" }, T0)).toBe("sent");
      expect(await liveRows(accountId)).toHaveLength(1);
    });
  });

  describe("общая очередь notifications-bot", () => {
    let queue: BotNotifyQueue;
    let bull: Queue;
    const handled: string[] = [];

    beforeAll(async () => {
      queue = new BotNotifyQueue(config, {} as never, {} as never);
      await queue.onApplicationBootstrap();
      queue.registerPaced("card-itest", async (data) => {
        handled.push(String((data as { tag?: unknown }).tag));
      });
      bull = (queue as unknown as { queue: Queue }).queue;
    });

    afterAll(async () => {
      for (const job of await bull.getJobs(["delayed", "waiting", "failed", "completed"])) if (job.name === "card-itest") await job.remove();
      await queue.onModuleDestroy();
    });

    async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
      const startedAt = Date.now();
      while (!condition()) {
        if (Date.now() - startedAt > timeoutMs) throw new Error("не дождались задания");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    it("addPaced с тем же jobId дважды — одно задание, пока оно ждёт", async () => {
      const jobId = `card-itest-${randomUUID()}`;
      expect(await queue.addPaced("card-itest", { tag: "a" }, { jobId, delayMs: 60_000 })).toBe(true);
      expect(await queue.addPaced("card-itest", { tag: "b" }, { jobId, delayMs: 60_000 })).toBe(true);
      const found = (await bull.getJobs(["delayed"])).filter((job) => job.id === jobId);
      expect(found).toHaveLength(1);
      expect(found[0]?.data).toEqual({ tag: "a" });
      expect(found[0]?.opts.delay).toBeGreaterThan(0);
      await found[0]?.remove();
    });

    it("после выполнения тот же jobId ставится снова: выполненное задание не хранится", async () => {
      const jobId = `card-itest-${randomUUID()}`;
      const tag = randomUUID();
      await queue.addPaced("card-itest", { tag }, { jobId, delayMs: 0 });
      await waitFor(() => handled.filter((item) => item === tag).length === 1);
      await queue.addPaced("card-itest", { tag }, { jobId, delayMs: 0 });
      await waitFor(() => handled.filter((item) => item === tag).length === 2);
      expect(await bull.getJob(jobId)).toBeUndefined();
    });

    it("двоеточие в jobId BullMQ не пропускает — идентификаторы карточек его не содержат", async () => {
      await expect(queue.addPaced("card-itest", { tag: "x" }, { jobId: "card-edit:abc", delayMs: 0 })).rejects.toThrow();
    });
  });
});
