import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Logger, type Type } from "@nestjs/common";
import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadAppConfig } from "../src/config/app-config.js";
import { BotCardEvents, type BotCardQuery } from "../src/modules/bot-cards/bot-card-events.js";
import { BotCardKinds, type BotCardKind } from "../src/modules/bot-cards/bot-card-kinds.js";
import { cardLockKey, encodeState, stateHash } from "../src/modules/bot-cards/bot-card-protocol.js";
import { BotCardsAnswerer } from "../src/modules/bot-cards/bot-cards-answerer.js";
import { BotCardsFinalizer } from "../src/modules/bot-cards/bot-cards.finalizer.js";
import { BotCardsModule } from "../src/modules/bot-cards/bot-cards.module.js";
import type { BotCardRow, BotCardsRepository, NewBotCard, OpenResult } from "../src/modules/bot-cards/bot-cards.repository.js";
import { BotCardsService, type CardSendInput } from "../src/modules/bot-cards/bot-cards.service.js";
import { BotCardsUpdater } from "../src/modules/bot-cards/bot-cards.updater.js";
import { AccountSettingsModule } from "../src/modules/account-settings/account-settings.module.js";
import { AuthModule } from "../src/modules/auth/auth.module.js";
import { BotMessagesModule } from "../src/modules/bot-messages/bot-messages.module.js";
import type { BotMessageSent } from "../src/modules/bot-messages/bot-message-events.js";
import { BotMessages } from "../src/modules/bot-messages/bot-messages.service.js";
import type { BotMessageDecision } from "../src/modules/bot-messages/bot-message-policy.js";
import { MessagingModule } from "../src/modules/messaging/messaging.module.js";
import type { MessagingState } from "../src/modules/messaging/messaging.repository.js";
import { NotificationsBotModule } from "../src/modules/notifications-bot/notifications-bot.module.js";
import { BotNotifyQueue } from "../src/modules/notifications-bot/bot-notify-queue.js";
import { SETTINGS, type SettingDefinition, type SettingValue } from "../src/modules/settings/setting-catalog.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { LIVE_CARD_ANSWERER, LiveCards, type LiveCardMessage, type LiveCardPort, type LiveCardRef, type LiveCardSendOutcome, type LiveCardUpdateOutcome } from "../src/platforms/ports/live-card.js";
import { Messengers, type Messenger, type OutgoingMessage, type SendOutcome } from "../src/platforms/ports/messenger.js";
import { plainTextOf, type RichDocument } from "../src/platforms/ports/rich-message.js";
import { PlatformsModule, liveCardsFor } from "../src/platforms/platforms.module.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Живые карточки бота — ядро (docs/35-stage4-plan.md Р199, Р225; tasks/T-0395):
 * отправка и «живая — одна на вид», запасное сообщение, пауза после отказа
 * площадки, прореженные правки, финал периода и ответы на запросы. Всё без
 * базы и Redis: репозиторий, очередь и Redis — фейки; живые Postgres и Redis —
 * `bot-cards.integration.test.ts`.
 *
 * Время — `Date` из фейковых таймеров: часы Redis, срок паузы и «сейчас»
 * обработчиков заданий идут от него.
 */

const T0 = new Date(Date.UTC(2026, 10, 15, 9, 0));
const MIN = 60_000;
const PERIOD_NOW = "2026-W46";
const PERIOD_NEXT = "2026-W47";
const LAUNCH = (param: string): string => `https://t.me/rubezh_bot/play?startapp=${param}`;
const PLAY_BUTTON = { text: "▶ Играть", url: LAUNCH("n-season_card") };

const SEASON_ENABLED: SettingDefinition<boolean> = {
  key: "bot.widget.season.enabled",
  group: "Сообщения бота",
  title: "Карточка «Сезон»",
  hint: "тест",
  kind: "boolean",
  schema: z.boolean(),
  fromEnv: () => null,
  fallback: true,
};

/** Redis в памяти: `SET NX PX/EX`, `GET`, `DEL` и снятие лока скриптом; срок — от `Date.now()` фейковых таймеров. */
class FakeRedis {
  readonly entries = new Map<string, { value: string; expiresAt: number | null }>();
  down = false;

  private alive(key: string): { value: string; expiresAt: number | null } | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private check(): void {
    if (this.down) throw new Error("Redis недоступен");
  }

  has(key: string): boolean {
    return this.alive(key) !== undefined;
  }

  async set(key: string, value: string, ...options: (string | number)[]): Promise<"OK" | null> {
    this.check();
    if (options.includes("NX") && this.alive(key) !== undefined) return null;
    const px = options.indexOf("PX");
    const ex = options.indexOf("EX");
    const ttlMs = px >= 0 ? Number(options[px + 1]) : ex >= 0 ? Number(options[ex + 1]) * 1000 : null;
    this.entries.set(key, { value, expiresAt: ttlMs === null ? null : Date.now() + ttlMs });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    this.check();
    return this.alive(key)?.value ?? null;
  }

  async exists(key: string): Promise<number> {
    this.check();
    return this.alive(key) === undefined ? 0 : 1;
  }

  async del(...keys: string[]): Promise<number> {
    this.check();
    let removed = 0;
    for (const key of keys) if (this.entries.delete(key)) removed++;
    return removed;
  }

  /** Единственный скрипт сервиса — снять лок, только если он ещё мой. */
  async eval(_script: string, _keys: number, key: string, token: string): Promise<number> {
    this.check();
    if (this.alive(key)?.value !== token) return 0;
    this.entries.delete(key);
    return 1;
  }
}

interface QueuedJob {
  name: string;
  data: unknown;
  jobId: string;
  delayMs: number;
}

/** Очередь `notifications-bot` в памяти: один `jobId` — одно задание, пока оно не выполнено (как BullMQ без `removeOnComplete`). */
class FakeQueue {
  readonly handlers = new Map<string, (data: unknown) => Promise<void>>();
  jobs: QueuedJob[] = [];
  running = true;

  registerPaced(name: string, handler: (data: unknown) => Promise<void>): void {
    if (name === "notify") throw new Error("notify занято");
    if (this.handlers.has(name)) throw new Error(`обработчик ${name} уже есть`);
    this.handlers.set(name, handler);
  }

  async addPaced(name: string, data: unknown, options: { jobId: string; delayMs: number }): Promise<boolean> {
    if (!this.running) return false;
    if (!this.jobs.some((job) => job.jobId === options.jobId)) this.jobs.push({ name, data, jobId: options.jobId, delayMs: options.delayMs });
    return true;
  }

  of(name: string): QueuedJob[] {
    return this.jobs.filter((job) => job.name === name);
  }

  /** Выполнить и снять все задания имени. Ошибка обработчика летит наружу — как повтор в BullMQ. */
  async run(name: string): Promise<void> {
    const due = this.of(name);
    this.jobs = this.jobs.filter((job) => job.name !== name);
    const handler = this.handlers.get(name);
    if (handler === undefined) throw new Error(`нет обработчика ${name}`);
    for (const job of due) await handler(job.data);
  }
}

class FakePort implements LiveCardPort {
  readonly platform = "telegram" as const;
  configured = true;
  readonly supported = new Set(["season", "daily", "invites"]);
  readonly sends: { to: string; message: LiveCardMessage }[] = [];
  readonly updates: { ref: LiveCardRef; state: string }[] = [];
  sendOutcome: LiveCardSendOutcome | null = null;
  updateOutcome: LiveCardUpdateOutcome = { status: "edited" };
  private messageIds = 0;

  supports(kind: string): boolean {
    return this.supported.has(kind);
  }

  async send(platformUserId: string, message: LiveCardMessage): Promise<LiveCardSendOutcome> {
    this.sends.push({ to: platformUserId, message });
    this.messageIds++;
    return this.sendOutcome ?? { status: "sent", ref: { chatId: platformUserId, messageId: this.messageIds }, version: "ab12cd34" };
  }

  async update(ref: LiveCardRef, state: string): Promise<LiveCardUpdateOutcome> {
    this.updates.push({ ref, state });
    return this.updateOutcome;
  }
}

class FakeMessenger implements Messenger {
  readonly platform = "telegram" as const;
  readonly configured = true;
  readonly ratePerSec = 25;
  readonly sent: { to: string; message: OutgoingMessage }[] = [];
  next: SendOutcome = { status: "sent" };

  async send(platformUserId: string, message: OutgoingMessage): Promise<SendOutcome> {
    this.sent.push({ to: platformUserId, message });
    return this.next;
  }
}

/** Таблица `bot_card` в памяти. Строки отдаются копиями, как из базы. */
class MemoryBotCards implements BotCardsRepository {
  readonly rows: BotCardRow[] = [];
  /** следующая вставка проиграет гонку: вторая живая карточка вида */
  raceNext = false;

  async live(accountId: string, kind: string): Promise<BotCardRow | null> {
    const row = this.rows.find((candidate) => candidate.accountId === accountId && candidate.kind === kind && candidate.closedAt === null);
    return row === undefined ? null : { ...row };
  }

  async byId(id: string): Promise<BotCardRow | null> {
    const row = this.rows.find((candidate) => candidate.id === id);
    return row === undefined ? null : { ...row };
  }

  async byMessage(platform: string, chatId: string, messageId: number): Promise<BotCardRow | null> {
    const row = [...this.rows].reverse().find((candidate) => candidate.platform === platform && candidate.chatId === chatId && candidate.messageId === messageId);
    return row === undefined ? null : { ...row };
  }

  async openReplacing(card: NewBotCard): Promise<OpenResult> {
    const id = randomUUID();
    const row: BotCardRow = { id, ...card, createdAt: card.at, updatedAt: card.at, closedAt: null };
    if (this.raceNext) {
      this.raceNext = false;
      this.rows.push({ ...row, closedAt: card.at });
      return { status: "raced", id };
    }
    const prior = this.rows.find((candidate) => candidate.accountId === card.accountId && candidate.kind === card.kind && candidate.closedAt === null);
    if (prior !== undefined) prior.closedAt = card.at;
    this.rows.push(row);
    return { status: "opened", id, replacedId: prior?.id ?? null };
  }

  async touched(id: string, state: string, hash: string, at: Date): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.id === id && candidate.closedAt === null);
    if (row === undefined) return false;
    Object.assign(row, { state, stateHash: hash, updatedAt: at });
    return true;
  }

  async close(id: string, at: Date): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.id === id && candidate.closedAt === null);
    if (row === undefined) return false;
    row.closedAt = at;
    return true;
  }

  async dueForFinal(kind: string, currentPeriodKey: string, limit: number): Promise<BotCardRow[]> {
    return this.rows
      .filter((row) => row.kind === kind && row.closedAt === null && row.periodKey !== currentPeriodKey)
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }
}

interface World {
  place: number;
  period: string | null;
  stateCalls: number;
}

function seasonKind(world: World, overrides: Partial<BotCardKind> = {}): BotCardKind {
  return {
    kind: "season",
    enabled: SEASON_ENABLED,
    choice: { setting: "bot.seasonCard", byDefault: true },
    startRef: "n-season_card",
    periodKey: () => world.period,
    state: async () => {
      world.stateCalls++;
      return { place: world.place, week: world.period };
    },
    caption: (state) => `Сезон: место ${String(state.place)}`,
    fallback: (state): RichDocument => ({ blocks: [{ kind: "paragraph", text: `Сезон: место ${String(state.place)}` }] }),
    actions: ["claim"],
    act: async () => ({ outcome: "ok", result: { coins: 20 } }),
    ...overrides,
  };
}

const CONFIG = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);

function setup(panelValues: Record<string, SettingValue> = {}, kindOverrides: Partial<BotCardKind> = {}) {
  const panel = panelSettings({ "bot.formats.enabled": true, "bot.widget.enabled": true, ...panelValues });
  const world: World = { place: 3, period: PERIOD_NOW, stateCalls: 0 };
  const accounts = new MemoryAccountRepository();
  const port = new FakePort();
  const messenger = new FakeMessenger();
  const redis = new FakeRedis();
  const queue = new FakeQueue();
  const repository = new MemoryBotCards();
  const kinds = new BotCardKinds();
  const kind = seasonKind(world, kindOverrides);
  kinds.register(kind);
  const liveCards = new LiveCards([port]);
  const states = new Map<string, MessagingState>();
  const blocked: { platformUserId: string; reason: string }[] = [];
  const choices = new Map<string, boolean>();
  const events: BotMessageSent[] = [];
  const decision: { value: BotMessageDecision; inputs: unknown[] } = { value: { action: "send", silent: false }, inputs: [] };
  const queries: BotCardQuery[] = [];
  const limiter = { allowed: true, calls: [] as { rule: unknown; key: string }[] };

  const messaging = {
    state: async (accountId: string) => states.get(accountId) ?? null,
    platformChanged: async (_platform: string, platformUserId: string, reason: string) => {
      blocked.push({ platformUserId, reason });
    },
  };
  const service = new BotCardsService(
    panel,
    accounts,
    new Messengers([messenger]),
    liveCards,
    new AppLinks([{ platform: "telegram", launch: LAUNCH, chat: () => null }]),
    messaging,
    { valueOf: async (_accountId: string, key: string) => choices.get(key) },
    {
      decide: async (input) => {
        decision.inputs.push(input);
        return decision.value;
      },
    },
    new BotMessages(panel),
    {
      sent: async (event) => {
        events.push(event);
      },
    },
    kinds,
    repository,
    queue as unknown as BotNotifyQueue,
    redis as unknown as Redis,
  );
  service.onModuleInit();
  const updater = new BotCardsUpdater(liveCards, accounts, messaging, kinds, repository, queue as unknown as BotNotifyQueue, redis as unknown as Redis, service);
  updater.onModuleInit();
  const finalizer = new BotCardsFinalizer(CONFIG, kinds, repository, queue as unknown as BotNotifyQueue, redis as unknown as Redis);
  const answerer = new BotCardsAnswerer(
    panel,
    accounts,
    kinds,
    repository,
    {
      consume: async (rule, key) => {
        limiter.calls.push({ rule, key });
        return limiter.allowed;
      },
    },
    service,
    {
      queried: async (query: BotCardQuery) => {
        queries.push(query);
      },
    } as unknown as BotCardEvents,
    redis as unknown as Redis,
  );

  let nextUserId = 910_000;
  async function player(options: { canMessage?: boolean; banned?: boolean } = {}) {
    nextUserId++;
    const account = await accounts.upsert({ platform: "telegram", platformUserId: String(nextUserId), displayName: "Путник", username: null, photoUrl: null }, T0.getTime());
    if (options.canMessage !== false) states.set(account.accountId, { canMessage: true, reason: "entered", changedAt: T0 });
    if (options.banned === true) await accounts.setBan(account.accountId, { at: T0, reason: "тест" });
    return account;
  }

  const send = (accountId: string, input: Partial<CardSendInput> = {}, at: Date = new Date()) => service.send({ accountId, kind: "season", origin: "reply", ...input }, at);
  const query = (platformUserId: string, ref: LiveCardRef | null, data = "v1:r") => answerer.answer({ platform: "telegram", platformUserId, ref, data });

  return { panel, world, accounts, port, messenger, redis, queue, repository, kinds, kind, service, updater, finalizer, answerer, states, blocked, choices, events, decision, queries, limiter, player, send, query };
}

type Harness = ReturnType<typeof setup>;

const refOf = (row: BotCardRow): LiveCardRef => ({ chatId: row.chatId, messageId: row.messageId });
const lockKey = (accountId: string): string => `bot-cards:send:${accountId}:season`;

let warn: { mock: { calls: unknown[][] } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(T0);
  warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const warned = (event: string): number => warn.mock.calls.filter((call) => String(call[0]).includes(`"event":"${event}"`)).length;

describe("реестр видов и порт", () => {
  it("повтор вида при регистрации — исключение на старте", () => {
    const world: World = { place: 1, period: null, stateCalls: 0 };
    const kinds = new BotCardKinds();
    kinds.register(seasonKind(world));
    expect(() => kinds.register(seasonKind(world))).toThrow(/season/);
    expect(kinds.get("season")?.kind).toBe("season");
    expect(kinds.get("daily")).toBeUndefined();
    expect(kinds.all()).toHaveLength(1);
  });

  it("id вида — строчные латинские и подчёркивание, 3–16 знаков", () => {
    const world: World = { place: 1, period: null, stateCalls: 0 };
    const kinds = new BotCardKinds();
    for (const bad of ["Season", "ab", "season_card_with_long_name", "se-ason", "сезон"]) expect(() => kinds.register(seasonKind(world, { kind: bad })), bad).toThrow();
  });

  it("LiveCards: порт площадки — по идентификатору; нет порта или он не настроен — null", () => {
    const port = new FakePort();
    const cards = new LiveCards([port]);
    expect(cards.for("telegram")).toBe(port);
    expect(cards.for("max")).toBeNull();
    port.configured = false;
    expect(cards.for("telegram")).toBeNull();
  });

  it("сборка площадок отдаёт пустой реестр карточек: адаптер Telegram добавляет T-0396", () => {
    expect(liveCardsFor().for("telegram")).toBeNull();
  });
});

describe("отправка карточки", () => {
  it("отправка карточки: порту уходят вид, состояние с v: 1, подпись, кнопка «▶ Играть» и тишина по решению политики; строка в таблице живая", async () => {
    const s = setup();
    const account = await s.player();
    expect(await s.send(account.accountId)).toBe("sent");

    expect(s.port.sends).toHaveLength(1);
    expect(s.port.sends[0]?.to).toBe(account.platformUserId);
    expect(s.port.sends[0]?.message).toMatchObject({
      kind: "season",
      state: '{"v":1,"place":3,"week":"2026-W46"}',
      caption: "Сезон: место 3",
      button: PLAY_BUTTON,
      silent: false,
    });
    expect(s.messenger.sent).toEqual([]);
    const row = s.repository.rows[0];
    expect(row).toMatchObject({ accountId: account.accountId, platform: "telegram", kind: "season", chatId: account.platformUserId, messageId: 1, version: "ab12cd34", periodKey: PERIOD_NOW, closedAt: null });
    expect(row?.state).toBe('{"v":1,"place":3,"week":"2026-W46"}');
    expect(row?.stateHash).toBe(stateHash('{"v":1,"place":3,"week":"2026-W46"}'));
  });

  it("два вызова send(reply) подряд: две отправки порту, у первой — задание card-moved с moved: 1, живая карточка одна — вторая", async () => {
    const s = setup();
    const account = await s.player();
    expect(await s.send(account.accountId)).toBe("sent");
    expect(await s.send(account.accountId)).toBe("sent");

    expect(s.port.sends).toHaveLength(2);
    const [first, second] = s.repository.rows;
    expect(first?.closedAt).not.toBeNull();
    expect(second?.closedAt).toBeNull();
    expect((await s.repository.live(account.accountId, "season"))?.id).toBe(second?.id);
    expect(s.queue.of("card-moved")).toEqual([{ name: "card-moved", data: { cardId: first?.id }, jobId: `card-moved-${String(first?.id)}`, delayMs: 0 }]);

    await s.queue.run("card-moved");
    expect(s.port.updates).toEqual([{ ref: { chatId: account.platformUserId, messageId: 1 }, state: '{"v":1,"place":3,"week":"2026-W46","moved":1}' }]);
  });

  it("лок занят — busy, порт не вызван, а чужой лок остаётся на месте", async () => {
    const s = setup();
    const account = await s.player();
    await s.redis.set(lockKey(account.accountId), "чужой", "PX", 15_000, "NX");
    expect(await s.send(account.accountId)).toBe("busy");
    expect(s.port.sends).toEqual([]);
    expect(s.messenger.sent).toEqual([]);
    expect(await s.redis.get(lockKey(account.accountId))).toBe("чужой");
  });

  it("свой лок снимается после отправки и при сбое порта", async () => {
    const s = setup();
    const account = await s.player();
    await s.send(account.accountId);
    expect(s.redis.has(lockKey(account.accountId))).toBe(false);
    s.port.send = async () => {
      throw new Error("сеть");
    };
    await expect(s.send(account.accountId)).rejects.toThrow("сеть");
    expect(s.redis.has(lockKey(account.accountId))).toBe(false);
  });

  it("bot.formats.enabled выключен — off: бот пишет как до Р199, ничего не отправляется", async () => {
    const s = setup({ "bot.formats.enabled": false });
    const account = await s.player();
    expect(await s.send(account.accountId)).toBe("off");
    expect(s.port.sends).toEqual([]);
    expect(s.messenger.sent).toEqual([]);
    expect(s.repository.rows).toEqual([]);
  });

  it("вид не зарегистрирован — skipped", async () => {
    const s = setup();
    const account = await s.player();
    expect(await s.send(account.accountId, { kind: "unknown" })).toBe("skipped");
  });

  it("нет аккаунта и заблокированный аккаунт — skipped, лок не берётся", async () => {
    const s = setup();
    expect(await s.send(randomUUID())).toBe("skipped");
    const banned = await s.player({ banned: true });
    expect(await s.send(banned.accountId)).toBe("skipped");
    expect(s.port.sends).toEqual([]);
    expect(s.redis.entries.size).toBe(0);
  });

  it("писать нельзя (не начинал разговор или заблокировал бота) — not_allowed", async () => {
    const s = setup();
    const account = await s.player({ canMessage: false });
    expect(await s.send(account.accountId)).toBe("not_allowed");
    s.states.set(account.accountId, { canMessage: false, reason: "blocked", changedAt: T0 });
    expect(await s.send(account.accountId)).toBe("not_allowed");
    expect(s.port.sends).toEqual([]);
  });

  it("у площадки нет бота — skipped", async () => {
    const s = setup();
    const account = await s.accounts.upsert({ platform: "max", platformUserId: "77", displayName: "Макс", username: null, photoUrl: null }, T0.getTime());
    s.states.set(account.accountId, { canMessage: true, reason: "entered", changedAt: T0 });
    expect(await s.send(account.accountId)).toBe("skipped");
  });

  it("триггер (player) при выключенном выборе игрока — opted_out; команда (reply) при том же выборе — отправлена", async () => {
    const s = setup();
    const account = await s.player();
    s.choices.set("bot.seasonCard", false);
    expect(await s.send(account.accountId, { origin: "player" })).toBe("opted_out");
    expect(await s.send(account.accountId, { origin: "bot" })).toBe("opted_out");
    expect(s.port.sends).toEqual([]);
    expect(await s.send(account.accountId, { origin: "reply" })).toBe("sent");
    expect(s.port.sends).toHaveLength(1);
  });

  it("выбор игрока не задан — решает умолчание вида: выключенное умолчание тоже opted_out", async () => {
    const s = setup({}, { choice: { setting: "bot.seasonCard", byDefault: false } });
    const account = await s.player();
    expect(await s.send(account.accountId, { origin: "player" })).toBe("opted_out");
    s.choices.set("bot.seasonCard", true);
    expect(await s.send(account.accountId, { origin: "player" })).toBe("sent");
  });

  it("у вида без выбора игрока триггер отправляется без проверки", async () => {
    const s = setup({}, { choice: null });
    const account = await s.player();
    expect(await s.send(account.accountId, { origin: "player" })).toBe("sent");
  });

  it("политика wait (тихие часы) — deferred: задание card-send с задержкой до конца тихих часов и origin: bot; порт не вызван", async () => {
    const s = setup();
    const account = await s.player();
    s.decision.value = { action: "wait", untilMs: T0.getTime() + 11 * 60 * MIN };
    expect(await s.send(account.accountId, { origin: "bot" }, T0)).toBe("deferred");
    expect(s.port.sends).toEqual([]);
    expect(s.queue.of("card-send")).toEqual([
      { name: "card-send", data: { accountId: account.accountId, kind: "season", origin: "bot" }, jobId: `card-send-${account.accountId}-season-${PERIOD_NOW}-late`, delayMs: 11 * 60 * MIN },
    ]);
  });

  it("политика skip — skipped", async () => {
    const s = setup();
    const account = await s.player();
    s.decision.value = { action: "skip", reason: "quiet_hours" };
    expect(await s.send(account.accountId, { origin: "bot" })).toBe("skipped");
  });

  it("звук решает политика: silent: true в сообщении порту; origin и аккаунт — в её запросе", async () => {
    const s = setup();
    const account = await s.player();
    s.decision.value = { action: "send", silent: true };
    await s.send(account.accountId, { origin: "player" });
    expect(s.port.sends[0]?.message.silent).toBe(true);
    expect(s.decision.inputs).toEqual([{ accountId: account.accountId, origin: "player" }]);
  });

  it("silent задан вызывающим — политика не спрашивается: счётчик звука не растёт дважды", async () => {
    const s = setup();
    const account = await s.player();
    s.decision.value = { action: "wait", untilMs: T0.getTime() + MIN };
    expect(await s.send(account.accountId, { origin: "bot", silent: true })).toBe("sent");
    expect(s.decision.inputs).toEqual([]);
    expect(s.port.sends[0]?.message.silent).toBe(true);
    expect(await s.send(account.accountId, { origin: "bot", silent: false })).toBe("sent");
    expect(s.port.sends[1]?.message.silent).toBe(false);
    expect(s.decision.inputs).toEqual([]);
  });

  it("событие bot_message_sent: kind season_card, format card, исход, тема и звук", async () => {
    const s = setup();
    const account = await s.player();
    s.decision.value = { action: "send", silent: true };
    await s.send(account.accountId, { origin: "player" });
    expect(s.events).toEqual([{ kind: "season_card", format: "card", outcome: "sent", topic: "none", silent: true, platform: "telegram" }]);
  });

  it("у вида есть тема — она уходит и порту, и в событие", async () => {
    const s = setup({}, { topic: "rewards" });
    const account = await s.player();
    await s.send(account.accountId);
    expect(s.port.sends[0]?.message.topic).toBe("rewards");
    expect(s.events[0]?.topic).toBe("rewards");
  });

  it("порт ответил blocked — игрок помечен «заблокировал», итог blocked, карточки в таблице нет", async () => {
    const s = setup();
    const account = await s.player();
    s.port.sendOutcome = { status: "blocked" };
    expect(await s.send(account.accountId)).toBe("blocked");
    expect(s.blocked).toEqual([{ platformUserId: account.platformUserId, reason: "blocked" }]);
    expect(s.repository.rows).toEqual([]);
    expect(s.events[0]).toMatchObject({ format: "card", outcome: "blocked" });
  });

  it("порт ответил failed — итог failed, запасное сообщение не шлётся (повтор не поможет), событие failed", async () => {
    const s = setup();
    const account = await s.player();
    s.port.sendOutcome = { status: "failed", reason: "400" };
    expect(await s.send(account.accountId)).toBe("failed");
    expect(s.messenger.sent).toEqual([]);
    expect(s.events[0]).toMatchObject({ format: "card", outcome: "failed" });
  });

  it("площадка просит подождать: send отвечает failed без события, а задание card-send бросает — повтор BullMQ", async () => {
    const s = setup();
    const account = await s.player();
    s.port.sendOutcome = { status: "retry", afterSec: 5 };
    expect(await s.send(account.accountId)).toBe("failed");
    expect(s.events).toEqual([]);
    await s.service.sendLater({ accountId: account.accountId, kind: "season", origin: "player" }, T0);
    await expect(s.queue.run("card-send")).rejects.toThrow();
    expect(s.repository.rows).toEqual([]);
  });

  it("гонка мимо лока: вставка проиграла индексу — карточка закрыта сразу, ей уходит card-moved, в логе card_race, итог всё равно sent", async () => {
    const s = setup();
    const account = await s.player();
    s.repository.raceNext = true;
    expect(await s.send(account.accountId)).toBe("sent");
    const row = s.repository.rows[0];
    expect(row?.closedAt).not.toBeNull();
    expect(s.queue.of("card-moved")).toHaveLength(1);
    expect(s.queue.of("card-moved")[0]?.data).toEqual({ cardId: row?.id });
    expect(warned("card_race")).toBe(1);
    await s.queue.run("card-moved");
    expect(s.port.updates[0]?.state).toBe('{"v":1,"place":3,"week":"2026-W46","moved":1}');
  });

  it("Redis недоступен: отправка идёт без лока — карточку по-прежнему держит индекс таблицы", async () => {
    const s = setup();
    const account = await s.player();
    s.redis.down = true;
    expect(await s.send(account.accountId)).toBe("sent");
    expect(s.port.sends).toHaveLength(1);
  });

  it("слишком большое состояние вида — ошибка в коде вида, а не обрезка: RangeError, карточка не уходит, лок снят", async () => {
    const s = setup({}, { state: async () => ({ text: "я".repeat(600) }) });
    const account = await s.player();
    await expect(s.send(account.accountId)).rejects.toThrow(RangeError);
    expect(s.port.sends).toEqual([]);
    expect(s.redis.has(lockKey(account.accountId))).toBe(false);
  });
});

describe("запасное сообщение вместо карточки (Р225)", () => {
  const expectedFallback = (): OutgoingMessage => ({
    text: "Сезон: место 3",
    button: PLAY_BUTTON,
    rich: { blocks: [{ kind: "paragraph", text: "Сезон: место 3" }] },
  });

  it("bot.widget.enabled выключен — порт не вызван, messenger.send с fallback(state) и кнопкой, итог fallback; в таблице пусто", async () => {
    const s = setup({ "bot.widget.enabled": false });
    const account = await s.player();
    expect(await s.send(account.accountId)).toBe("fallback");
    expect(s.port.sends).toEqual([]);
    expect(s.messenger.sent).toEqual([{ to: account.platformUserId, message: expectedFallback() }]);
    expect(s.repository.rows).toEqual([]);
    expect(s.events).toEqual([{ kind: "season_card", format: "rich", outcome: "sent", topic: "none", silent: false, platform: "telegram" }]);
  });

  it("ключ вида выключен — то же запасное сообщение, а не off", async () => {
    const s = setup({ [SEASON_ENABLED.key]: false });
    const account = await s.player();
    expect(await s.send(account.accountId)).toBe("fallback");
    expect(s.port.sends).toEqual([]);
    expect(s.messenger.sent).toHaveLength(1);
  });

  it("запасное сообщение несёт звук, решённый политикой", async () => {
    const s = setup({ "bot.widget.enabled": false });
    const account = await s.player();
    s.decision.value = { action: "send", silent: true };
    await s.send(account.accountId, { origin: "player" });
    expect(s.messenger.sent[0]?.message.silent).toBe(true);
    expect(s.events[0]?.silent).toBe(true);
  });

  it("порт не поддерживает вид — запасное сообщение с plainTextOf(fallback) и кнопкой; формат события rich", async () => {
    const s = setup();
    s.port.supported.clear();
    const account = await s.player();
    expect(await s.send(account.accountId)).toBe("fallback");
    expect(s.port.sends).toEqual([]);
    expect(s.messenger.sent[0]?.message.text).toBe(plainTextOf(s.kind.fallback({ place: 3 })));
    expect(s.messenger.sent[0]?.message.button).toEqual(PLAY_BUTTON);
    expect(s.events[0]?.format).toBe("rich");
  });

  it("оформление выключено (bot.rich.enabled) — запасное сообщение простым текстом, формат события text", async () => {
    const s = setup({ "bot.rich.enabled": false, "bot.widget.enabled": false });
    const account = await s.player();
    await s.send(account.accountId);
    expect(s.messenger.sent[0]?.message).toEqual({ text: "Сезон: место 3", button: PLAY_BUTTON });
    expect(s.events[0]?.format).toBe("text");
  });

  it("запасное сообщение: площадка заменила оформление текстом — исход fallback в событии", async () => {
    const s = setup({ "bot.widget.enabled": false });
    const account = await s.player();
    s.messenger.next = { status: "sent", fallback: true };
    await s.send(account.accountId);
    expect(s.events[0]).toMatchObject({ format: "rich", outcome: "fallback" });
  });

  it("запасное сообщение: игрок заблокировал бота — blocked и отметка у игрока", async () => {
    const s = setup({ "bot.widget.enabled": false });
    const account = await s.player();
    s.messenger.next = { status: "blocked" };
    expect(await s.send(account.accountId)).toBe("blocked");
    expect(s.blocked).toEqual([{ platformUserId: account.platformUserId, reason: "blocked" }]);
  });

  it("порт ответил unsupported — запасное сообщение сразу, итог fallback; пауза площадки стоит; тревога одна; следующая отправка — без вызова порта; после срока порт вызывается снова", async () => {
    const s = setup();
    const account = await s.player();
    s.port.sendOutcome = { status: "unsupported" };

    expect(await s.send(account.accountId)).toBe("fallback");
    expect(s.port.sends).toHaveLength(1);
    expect(s.messenger.sent).toEqual([{ to: account.platformUserId, message: expectedFallback() }]);
    expect(s.redis.has("bot-cards:paused:telegram")).toBe(true);
    expect(warned("widgets_unavailable")).toBe(1);
    expect(s.repository.rows).toEqual([]);

    // Другая реплика, уже прошедшая проверку паузы, получает тот же отказ: ключ занят, тревоги второй нет.
    await s.service.pause("telegram");
    expect(warned("widgets_unavailable")).toBe(1);

    expect(await s.send(account.accountId)).toBe("fallback");
    expect(s.port.sends).toHaveLength(1);
    expect(s.messenger.sent).toHaveLength(2);

    // 30 минут по умолчанию (bot.widget.retry-minutes).
    vi.setSystemTime(new Date(T0.getTime() + 29 * MIN));
    expect(await s.send(account.accountId)).toBe("fallback");
    expect(s.port.sends).toHaveLength(1);
    vi.setSystemTime(new Date(T0.getTime() + 31 * MIN));
    s.port.sendOutcome = null;
    expect(await s.send(account.accountId)).toBe("sent");
    expect(s.port.sends).toHaveLength(2);
  });

  it("срок паузы берётся из bot.widget.retry-minutes", async () => {
    const s = setup({ "bot.widget.retry-minutes": 5 });
    await s.service.pause("telegram");
    vi.setSystemTime(new Date(T0.getTime() + 4 * MIN));
    expect(await s.service.isPaused("telegram")).toBe(true);
    vi.setSystemTime(new Date(T0.getTime() + 6 * MIN));
    expect(await s.service.isPaused("telegram")).toBe(false);
  });

  it("unsupported при недоступном Redis — пауза не поставилась, но запасное сообщение уходит", async () => {
    const s = setup();
    const account = await s.player();
    s.port.sendOutcome = { status: "unsupported" };
    s.redis.down = true;
    expect(await s.send(account.accountId)).toBe("fallback");
    expect(s.messenger.sent).toHaveLength(1);
  });

  it("пауза одной площадки не касается другой: проверка по ключу площадки", async () => {
    const s = setup();
    await s.service.pause("max");
    expect(await s.service.isPaused("telegram")).toBe(false);
    expect(await s.service.isPaused("max")).toBe(true);
  });
});

describe("отправка по триггеру через очередь", () => {
  it("sendLater ставит card-send без задержки, jobId — аккаунт, вид и период; повтор в тот же период — то же задание", async () => {
    const s = setup();
    const account = await s.player();
    expect(await s.service.sendLater({ accountId: account.accountId, kind: "season", origin: "player" }, T0)).toBe(true);
    expect(await s.service.sendLater({ accountId: account.accountId, kind: "season", origin: "player" }, T0)).toBe(true);
    expect(s.queue.of("card-send")).toEqual([
      { name: "card-send", data: { accountId: account.accountId, kind: "season", origin: "player" }, jobId: `card-send-${account.accountId}-season-${PERIOD_NOW}`, delayMs: 0 },
    ]);
    expect(s.port.sends).toEqual([]);
  });

  it("у вида без периода jobId несёт none; неизвестный вид — false, очередь не запущена — false", async () => {
    const s = setup({}, { periodKey: () => null });
    const account = await s.player();
    await s.service.sendLater({ accountId: account.accountId, kind: "season", origin: "bot" }, T0);
    expect(s.queue.of("card-send")[0]?.jobId).toBe(`card-send-${account.accountId}-season-none`);
    expect(await s.service.sendLater({ accountId: account.accountId, kind: "nope", origin: "bot" }, T0)).toBe(false);
    s.queue.running = false;
    expect(await s.service.sendLater({ accountId: randomUUID(), kind: "season", origin: "bot" }, T0)).toBe(false);
  });

  it("обработчик card-send вызывает send с origin из задания", async () => {
    const s = setup();
    const account = await s.player();
    s.decision.value = { action: "send", silent: true };
    await s.service.sendLater({ accountId: account.accountId, kind: "season", origin: "player" }, T0);
    await s.queue.run("card-send");
    expect(s.port.sends).toHaveLength(1);
    expect(s.decision.inputs).toEqual([{ accountId: account.accountId, origin: "player" }]);
  });

  it("задание card-send не по схеме — ошибка, а не отправка наугад", async () => {
    const s = setup();
    const handler = s.queue.handlers.get("card-send");
    await expect(handler?.({ accountId: "не uuid", kind: "season", origin: "bot" })).rejects.toThrow();
    await expect(handler?.({ accountId: randomUUID(), kind: "season", origin: "кто-то" })).rejects.toThrow();
    expect(s.port.sends).toEqual([]);
  });

  it("отложенная тихими часами отправка уходит после них: задание card-send с origin bot проходит ту же проверку", async () => {
    const s = setup();
    const account = await s.player();
    s.decision.value = { action: "wait", untilMs: T0.getTime() + 11 * 60 * MIN };
    await s.send(account.accountId, { origin: "bot" }, T0);
    s.decision.value = { action: "send", silent: false };
    await s.queue.run("card-send");
    expect(s.port.sends).toHaveLength(1);
  });

  it("очередь не запущена (без входа игроков) — отложить нечем: skipped, а не deferred", async () => {
    const s = setup();
    const account = await s.player();
    s.queue.running = false;
    s.decision.value = { action: "wait", untilMs: T0.getTime() + MIN };
    expect(await s.send(account.accountId, { origin: "bot" }, T0)).toBe("skipped");
  });
});

describe("правки отправленных карточек", () => {
  async function sent(s: Harness) {
    const account = await s.player();
    await s.send(account.accountId, {}, T0);
    const row = s.repository.rows[0];
    if (row === undefined) throw new Error("карточка не отправилась");
    return { account, row };
  }

  it("touch дважды за десять минут — одно задание card-edit с задержкой до updatedAt + 10 минут", async () => {
    const s = setup();
    const { account, row } = await sent(s);
    await s.service.touch(account.accountId, "season", new Date(T0.getTime() + 2 * MIN));
    await s.service.touch(account.accountId, "season", new Date(T0.getTime() + 5 * MIN));
    expect(s.queue.of("card-edit")).toEqual([{ name: "card-edit", data: { cardId: row.id }, jobId: `card-edit-${row.id}-${String(T0.getTime())}`, delayMs: 8 * MIN }]);
  });

  it("прошло больше десяти минут — правка сразу; интервал берётся из bot.widget.edit-min-minutes", async () => {
    const s = setup({ "bot.widget.edit-min-minutes": 3 });
    const { account } = await sent(s);
    await s.service.touch(account.accountId, "season", new Date(T0.getTime() + 2 * MIN));
    expect(s.queue.of("card-edit")[0]?.delayMs).toBe(MIN);
    s.queue.jobs = [];
    await s.service.touch(account.accountId, "season", new Date(T0.getTime() + 30 * MIN));
    expect(s.queue.of("card-edit")[0]?.delayMs).toBe(0);
  });

  it("touch без живой карточки, с выключенными карточками или неизвестным видом — ничего не ставит", async () => {
    const s = setup();
    const account = await s.player();
    await s.service.touch(account.accountId, "season", T0);
    await s.service.touch(account.accountId, "nope", T0);
    expect(s.queue.jobs).toEqual([]);
    await s.send(account.accountId, {}, T0);
    s.panel.set("bot.widget.enabled", false);
    await s.service.touch(account.accountId, "season", T0);
    s.panel.set("bot.widget.enabled", true);
    s.panel.set("bot.formats.enabled", false);
    await s.service.touch(account.accountId, "season", T0);
    s.panel.set("bot.formats.enabled", true);
    s.panel.set(SEASON_ENABLED.key, false);
    await s.service.touch(account.accountId, "season", T0);
    expect(s.queue.jobs).toEqual([]);
  });

  it("card-edit: состояние изменилось — площадке уходит новое, таблица помнит его, хэш и время правки", async () => {
    const s = setup();
    const { account, row } = await sent(s);
    s.world.place = 2;
    await s.service.touch(account.accountId, "season", T0);
    vi.setSystemTime(new Date(T0.getTime() + 11 * MIN));
    await s.queue.run("card-edit");

    const expected = '{"v":1,"place":2,"week":"2026-W46"}';
    expect(s.port.updates).toEqual([{ ref: refOf(row), state: expected }]);
    const after = await s.repository.byId(row.id);
    expect(after).toMatchObject({ state: expected, stateHash: stateHash(expected), closedAt: null });
    expect(after?.updatedAt).toEqual(new Date(T0.getTime() + 11 * MIN));
  });

  it("касание во время правки не теряется: слот занят до вызова площадки, и новое задание ждёт интервал от начала правки", async () => {
    const s = setup();
    const { account, row } = await sent(s);
    s.world.place = 2;
    await s.service.touch(account.accountId, "season", T0);
    vi.setSystemTime(new Date(T0.getTime() + 11 * MIN));
    let release: () => void = () => undefined;
    s.port.update = async (ref, state) => {
      s.port.updates.push({ ref, state });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: "edited" };
    };
    const running = s.queue.run("card-edit");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.port.updates).toHaveLength(1);

    // Состояние изменилось, пока площадка отвечает: прежнее задание уже выполняется, но слот занят — новое не теряется.
    s.world.place = 1;
    await s.service.touch(account.accountId, "season", new Date());
    expect(s.queue.of("card-edit")).toHaveLength(1);
    expect(s.queue.of("card-edit")[0]?.jobId).toMatch(new RegExp(`^card-edit-${row.id}-.*-again-`));
    expect(s.queue.of("card-edit")[0]?.delayMs).toBe(10 * MIN);
    release();
    await running;
  });

  it("касание во время сборки состояния не теряется: пока активное задание держит карточку, ставится отдельное", async () => {
    const s = setup();
    const { account, row } = await sent(s);
    s.world.place = 2;
    await s.service.touch(account.accountId, "season", T0);
    vi.setSystemTime(new Date(T0.getTime() + 11 * MIN));

    const state = s.kind.state;
    let releaseState: () => void = () => undefined;
    let first = true;
    s.kind.state = async (accountId, at) => {
      const value = await state(accountId, at);
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          releaseState = resolve;
        });
      }
      return value;
    };

    // Состояние собирается, слот ещё не сдвинут: касание видит прежний updatedAt, и его jobId совпал бы с активным.
    const running = s.queue.run("card-edit");
    await vi.advanceTimersByTimeAsync(0);
    s.world.place = 1;
    await s.service.touch(account.accountId, "season", new Date());
    expect(s.queue.of("card-edit")).toHaveLength(1);
    expect(s.queue.of("card-edit")[0]?.jobId).toContain("-again-");
    releaseState();
    await running;
    expect((await s.repository.byId(row.id))?.state).toBe('{"v":1,"place":2,"week":"2026-W46"}');

    // Отдельное задание доживает до своего срока и доносит состояние, собранное после касания.
    await vi.advanceTimersByTimeAsync(10 * MIN);
    await s.queue.run("card-edit");
    expect((await s.repository.byId(row.id))?.state).toBe('{"v":1,"place":1,"week":"2026-W46"}');
  });

  it("правка не переходит границу периода: состояние нового периода в старую карточку не пишется", async () => {
    const s = setup();
    const { account, row } = await sent(s);
    s.world.period = PERIOD_NEXT;
    s.world.place = 9;
    await s.service.touch(account.accountId, "season", T0);
    await s.queue.run("card-edit");
    expect(s.port.updates).toEqual([]);
    expect((await s.repository.byId(row.id))?.state).toBe('{"v":1,"place":3,"week":"2026-W46"}');

    // Финал берёт состояние своего периода, а не нового: в задании и на площадке — прежние место и неделя.
    s.queue.jobs = [];
    const summary = await s.finalizer.tick(new Date(T0.getTime() + 12 * MIN));
    expect(summary).toMatchObject({ status: "done", queued: 1 });
    const job = s.queue.of("card-final")[0];
    expect(job?.data).toMatchObject({ cardId: row.id, state: '{"v":1,"place":3,"week":"2026-W46","x":1}' });
    await s.queue.run("card-final");
    expect(s.port.updates).toEqual([{ ref: refOf(row), state: '{"v":1,"place":3,"week":"2026-W46","x":1}' }]);
  });

  it("сборка состояния не ответила за срок — задание бросает, лок карточки держится до истечения срока", async () => {
    const s = setup();
    const { account, row } = await sent(s);
    s.world.place = 2;
    await s.service.touch(account.accountId, "season", T0);
    s.kind.state = () => new Promise(() => undefined);

    const running = s.queue.run("card-edit");
    const failed = expect(running).rejects.toThrow(/нет ответа за 8000 мс/);
    await vi.advanceTimersByTimeAsync(8_000);
    await failed;
    expect(s.redis.has(cardLockKey(row.id))).toBe(true);
    // Поверх брошенного вызова вторая операция не идёт: лок ещё держит.
    await expect(s.updater.moved({ cardId: row.id })).rejects.toThrow(/занята/);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.redis.has(cardLockKey(row.id))).toBe(false);
  });

  it("площадка не ответила за срок — задание бросает, лок карточки держится до истечения срока", async () => {
    const s = setup();
    const { account, row } = await sent(s);
    s.world.place = 2;
    await s.service.touch(account.accountId, "season", T0);
    s.port.update = () => new Promise(() => undefined);

    const running = s.queue.run("card-edit");
    const failed = expect(running).rejects.toThrow(/нет ответа за 10000 мс/);
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    expect(s.redis.has(cardLockKey(row.id))).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.redis.has(cardLockKey(row.id))).toBe(false);
  });

  it("card-edit с тем же хэшем — площадка не вызывается", async () => {
    const s = setup();
    const { account } = await sent(s);
    await s.service.touch(account.accountId, "season", T0);
    await s.queue.run("card-edit");
    expect(s.port.updates).toEqual([]);
  });

  it("card-edit: сообщения больше нет (gone) — карточка закрыта", async () => {
    const s = setup();
    const { account, row } = await sent(s);
    s.world.place = 1;
    s.port.updateOutcome = { status: "gone" };
    await s.service.touch(account.accountId, "season", T0);
    await s.queue.run("card-edit");
    expect((await s.repository.byId(row.id))?.closedAt).not.toBeNull();
  });

  it("card-edit: площадка отказала в методе (unsupported) — карточка закрыта, пауза стоит; следующая правка площадку не зовёт", async () => {
    const s = setup();
    const { account, row } = await sent(s);
    s.world.place = 1;
    s.port.updateOutcome = { status: "unsupported" };
    await s.service.touch(account.accountId, "season", T0);
    await s.queue.run("card-edit");
    expect((await s.repository.byId(row.id))?.closedAt).not.toBeNull();
    expect(s.redis.has("bot-cards:paused:telegram")).toBe(true);
    expect(warned("widgets_unavailable")).toBe(1);

    // Живая карточка другого вида под паузой: правка выходит без вызова площадки.
    const second = await s.player();
    s.port.sendOutcome = null;
    s.redis.entries.delete("bot-cards:paused:telegram");
    await s.send(second.accountId, {}, T0);
    s.world.place = 9;
    await s.service.pause("telegram");
    const callsBefore = s.port.updates.length;
    await s.service.touch(second.accountId, "season", T0);
    await s.queue.run("card-edit");
    expect(s.port.updates).toHaveLength(callsBefore);
    expect((await s.repository.live(second.accountId, "season"))?.closedAt).toBeNull();
  });

  it("card-edit при выключенных bot.widget.enabled или ключе вида — выход без вызова площадки, карточка живая", async () => {
    const s = setup();
    const { account } = await sent(s);
    s.world.place = 1;
    await s.service.touch(account.accountId, "season", T0);
    s.panel.set("bot.widget.enabled", false);
    await s.queue.run("card-edit");
    expect(s.port.updates).toEqual([]);
    expect((await s.repository.live(account.accountId, "season"))?.closedAt).toBeNull();

    await s.service.touch(account.accountId, "season", T0);
    s.panel.set("bot.widget.enabled", true);
    s.panel.set(SEASON_ENABLED.key, false);
    await s.queue.run("card-edit");
    expect(s.port.updates).toEqual([]);
  });

  it("card-edit: площадка просит подождать — обработчик бросает, повтор BullMQ; карточка и хэш прежние", async () => {
    const s = setup();
    const { account, row } = await sent(s);
    s.world.place = 1;
    s.port.updateOutcome = { status: "retry", afterSec: 5 };
    await s.service.touch(account.accountId, "season", T0);
    await expect(s.queue.run("card-edit")).rejects.toThrow();
    expect((await s.repository.byId(row.id))?.stateHash).toBe(row.stateHash);
  });

  it("card-edit: игрок заблокировал бота — карточка закрыта и игрок помечен", async () => {
    const s = setup();
    const { account, row } = await sent(s);
    s.world.place = 1;
    s.port.updateOutcome = { status: "blocked" };
    await s.service.touch(account.accountId, "season", T0);
    await s.queue.run("card-edit");
    expect((await s.repository.byId(row.id))?.closedAt).not.toBeNull();
    expect(s.blocked).toEqual([{ platformUserId: account.platformUserId, reason: "blocked" }]);
  });

  it("card-edit: отказ площадки без повтора (failed) — запись в лог, карточка живая, исключения нет", async () => {
    const s = setup();
    const { account, row } = await sent(s);
    s.world.place = 1;
    s.port.updateOutcome = { status: "failed", reason: "400" };
    await s.service.touch(account.accountId, "season", T0);
    await expect(s.queue.run("card-edit")).resolves.toBeUndefined();
    expect((await s.repository.byId(row.id))?.closedAt).toBeNull();
    expect(warned("card_update_failed")).toBe(1);
  });

  it("card-edit закрытой или несуществующей карточки — выход без вызова площадки", async () => {
    const s = setup();
    const { account, row } = await sent(s);
    s.world.place = 1;
    await s.service.touch(account.accountId, "season", T0);
    await s.repository.close(row.id, T0);
    await s.queue.run("card-edit");
    const handler = s.queue.handlers.get("card-edit");
    await handler?.({ cardId: randomUUID() });
    expect(s.port.updates).toEqual([]);
  });

  it("card-edit: кто-то держит карточку (правка и финал на разных репликах) — задание бросает и повторится, карточка не затёрта", async () => {
    const s = setup();
    const { account, row } = await sent(s);
    s.world.place = 1;
    await s.service.touch(account.accountId, "season", T0);
    await s.redis.set(`bot-cards:card:${row.id}`, "чужой", "PX", 15_000, "NX");
    await expect(s.queue.run("card-edit")).rejects.toThrow();
    expect(s.port.updates).toEqual([]);
    expect(await s.redis.get(`bot-cards:card:${row.id}`)).toBe("чужой");
  });

  it("задание card-edit не по схеме — ошибка", async () => {
    const s = setup();
    await expect(s.queue.handlers.get("card-edit")?.({ cardId: "не uuid" })).rejects.toThrow();
  });

  it("card-moved выключенных карточек: площадку не зовёт, карточка остаётся закрытой", async () => {
    const s = setup();
    const account = await s.player();
    await s.send(account.accountId, {}, T0);
    await s.send(account.accountId, {}, T0);
    s.panel.set("bot.widget.enabled", false);
    await s.queue.run("card-moved");
    expect(s.port.updates).toEqual([]);
  });

  it("card-moved: сообщения уже нет — тихий выход; отказ метода — пауза", async () => {
    const s = setup();
    const account = await s.player();
    await s.send(account.accountId, {}, T0);
    await s.send(account.accountId, {}, T0);
    s.port.updateOutcome = { status: "unsupported" };
    await s.queue.run("card-moved");
    expect(s.redis.has("bot-cards:paused:telegram")).toBe(true);
  });
});

describe("финал периода", () => {
  async function sentIn(s: Harness) {
    const account = await s.player();
    await s.send(account.accountId, {}, T0);
    const row = s.repository.rows[0];
    if (row === undefined) throw new Error("карточка не отправилась");
    return { account, row };
  }

  it("живая карточка прошлого периода — card-final с x: 1, затем площадке уходит финал и карточка закрыта; карточка текущего периода не тронута", async () => {
    const s = setup();
    const { account, row } = await sentIn(s);
    const other = await s.player();
    s.world.period = PERIOD_NEXT;
    await s.send(other.accountId, {}, new Date(T0.getTime() + 7 * 24 * 60 * MIN));
    const next = s.repository.rows[1];

    expect(await s.finalizer.tick(new Date(T0.getTime() + 7 * 24 * 60 * MIN))).toMatchObject({ status: "done", queued: 1 });
    expect(s.queue.of("card-final")).toEqual([
      { name: "card-final", data: { cardId: row.id, state: '{"v":1,"place":3,"week":"2026-W46","x":1}' }, jobId: `card-final-${row.id}`, delayMs: 0 },
    ]);
    expect(s.repository.rows.find((candidate) => candidate.id === next?.id)?.closedAt).toBeNull();

    s.world.place = 1;
    await s.queue.run("card-final");
    // Финал — состояние прошлой недели, а не нового периода.
    expect(s.port.updates).toEqual([{ ref: refOf(row), state: '{"v":1,"place":3,"week":"2026-W46","x":1}' }]);
    expect((await s.repository.byId(row.id))?.closedAt).not.toBeNull();
    expect((await s.repository.live(account.accountId, "season"))).toBeNull();
    expect((await s.repository.live(other.accountId, "season"))?.id).toBe(next?.id);
  });

  it("вид задал finalState — в задание идёт он, а не сохранённое состояние с x: 1", async () => {
    const s = setup({}, { finalState: (last) => ({ ...last, result: "closed", x: 1 }) });
    const { row } = await sentIn(s);
    s.world.period = PERIOD_NEXT;
    await s.finalizer.tick(T0);
    expect(s.queue.of("card-final")[0]?.data).toEqual({ cardId: row.id, state: '{"v":1,"place":3,"week":"2026-W46","result":"closed","x":1}' });
  });

  it("периода нет (periodKey → null) — вид без финала, живые карточки не трогаются", async () => {
    const s = setup({}, { periodKey: () => null });
    await sentIn(s);
    expect(await s.finalizer.tick(T0)).toMatchObject({ status: "done", queued: 0 });
    expect(s.queue.jobs).toEqual([]);
  });

  it("второй экземпляр при занятом локе ничего не делает; свой лок снимается после прохода", async () => {
    const s = setup();
    await sentIn(s);
    s.world.period = PERIOD_NEXT;
    await s.redis.set("bot-cards:final:lock", "другая реплика", "PX", 300_000, "NX");
    expect(await s.finalizer.tick(T0)).toMatchObject({ status: "locked", queued: 0 });
    expect(s.queue.jobs).toEqual([]);
    s.redis.entries.delete("bot-cards:final:lock");
    expect(await s.finalizer.tick(T0)).toMatchObject({ status: "done", queued: 1 });
    expect(s.redis.has("bot-cards:final:lock")).toBe(false);
  });

  it("проход повторяется — то же задание: один финал, а не два", async () => {
    const s = setup();
    await sentIn(s);
    s.world.period = PERIOD_NEXT;
    await s.finalizer.tick(T0);
    await s.finalizer.tick(new Date(T0.getTime() + 10 * MIN));
    expect(s.queue.of("card-final")).toHaveLength(1);
  });

  it("финал выполнен дважды (повтор BullMQ или две реплики) — площадка получает его один раз", async () => {
    const s = setup();
    const { row } = await sentIn(s);
    s.world.period = PERIOD_NEXT;
    await s.finalizer.tick(T0);
    const job = s.queue.of("card-final")[0];
    await s.queue.run("card-final");
    await s.queue.handlers.get("card-final")?.(job?.data);
    expect(s.port.updates).toHaveLength(1);
    expect((await s.repository.byId(row.id))?.closedAt).not.toBeNull();
  });

  it("гонка правки и финала: правка не затирает финал — после финала карточка закрыта и card-edit выходит", async () => {
    const s = setup();
    const { account } = await sentIn(s);
    s.world.place = 1;
    await s.service.touch(account.accountId, "season", T0);
    s.world.period = PERIOD_NEXT;
    await s.finalizer.tick(T0);
    await s.queue.run("card-final");
    await s.queue.run("card-edit");
    expect(s.port.updates).toHaveLength(1);
    expect(s.port.updates[0]?.state).toContain('"x":1');
  });

  it("правка держит карточку — финал бросает и повторится; финал держит — правка бросает", async () => {
    const s = setup();
    const { row } = await sentIn(s);
    s.world.period = PERIOD_NEXT;
    await s.finalizer.tick(T0);
    await s.redis.set(`bot-cards:card:${row.id}`, "правка", "PX", 15_000, "NX");
    await expect(s.queue.run("card-final")).rejects.toThrow();
    expect(s.port.updates).toEqual([]);
    expect((await s.repository.byId(row.id))?.closedAt).toBeNull();
  });

  it("финал: сообщения уже нет (gone) и отказ метода (unsupported) — карточка всё равно закрыта; при отказе встаёт пауза", async () => {
    const s = setup();
    const { row } = await sentIn(s);
    s.world.period = PERIOD_NEXT;
    await s.finalizer.tick(T0);
    s.port.updateOutcome = { status: "unsupported" };
    await s.queue.run("card-final");
    expect((await s.repository.byId(row.id))?.closedAt).not.toBeNull();
    expect(s.redis.has("bot-cards:paused:telegram")).toBe(true);
  });

  it("финал: площадка просит подождать — бросает, карточка остаётся живой для повтора", async () => {
    const s = setup();
    const { row } = await sentIn(s);
    s.world.period = PERIOD_NEXT;
    await s.finalizer.tick(T0);
    s.port.updateOutcome = { status: "retry", afterSec: 3 };
    await expect(s.queue.run("card-final")).rejects.toThrow();
    expect((await s.repository.byId(row.id))?.closedAt).toBeNull();
  });

  it("финал при выключенных карточках — площадка не зовётся, а карточка закрывается: проходы не накапливают задания вечно", async () => {
    const s = setup();
    const { row } = await sentIn(s);
    s.world.period = PERIOD_NEXT;
    await s.finalizer.tick(T0);
    s.panel.set("bot.widget.enabled", false);
    await s.queue.run("card-final");
    expect(s.port.updates).toEqual([]);
    expect((await s.repository.byId(row.id))?.closedAt).not.toBeNull();
  });

  it("финал под паузой площадки — выход без закрытия: проход подберёт карточку после паузы", async () => {
    const s = setup();
    const { row } = await sentIn(s);
    s.world.period = PERIOD_NEXT;
    await s.finalizer.tick(T0);
    await s.service.pause("telegram");
    await s.queue.run("card-final");
    expect(s.port.updates).toEqual([]);
    expect((await s.repository.byId(row.id))?.closedAt).toBeNull();
  });

  it("сбой чтения одного вида не мешает остальным: проход не бросает, итог failed не ломает следующий", async () => {
    const s = setup();
    await sentIn(s);
    s.world.period = PERIOD_NEXT;
    s.repository.dueForFinal = async () => {
      throw new Error("база");
    };
    await expect(s.finalizer.tick(T0)).resolves.toMatchObject({ status: "done", queued: 0 });
    expect(warned("final_scan_failed")).toBe(1);
  });

  it("без входа игроков проход не запускается; со входом идёт по таймеру и снимается при остановке", () => {
    const s = setup();
    const idle = new BotCardsFinalizer(loadAppConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), s.kinds, s.repository, s.queue as unknown as BotNotifyQueue, s.redis as unknown as Redis);
    idle.onApplicationBootstrap();
    expect(vi.getTimerCount()).toBe(0);
    s.finalizer.onApplicationBootstrap();
    expect(vi.getTimerCount()).toBe(1);
    s.finalizer.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("задание card-final не по схеме — ошибка; состояние длиннее 1024 байт — тоже", async () => {
    const s = setup();
    const handler = s.queue.handlers.get("card-final");
    await expect(handler?.({ cardId: randomUUID() })).rejects.toThrow();
    await expect(handler?.({ cardId: randomUUID(), state: "я".repeat(600) })).rejects.toThrow();
  });
});

describe("ответ на запрос карточки", () => {
  async function liveCard(s: Harness) {
    const account = await s.player();
    await s.send(account.accountId, {}, T0);
    const row = s.repository.rows[0];
    if (row === undefined) throw new Error("карточка не отправилась");
    return { account, row, ref: refOf(row) };
  }

  const lastQuery = (s: Harness): BotCardQuery | undefined => s.queries[s.queries.length - 1];

  it("мусор вместо запроса — err: bad; событие с видом unknown, исход error", async () => {
    const s = setup();
    const { account, ref } = await liveCard(s);
    expect(await s.query(account.platformUserId, ref, "привет")).toBe('{"v":1,"err":"bad"}');
    expect(lastQuery(s)).toEqual({ card: "unknown", action: "unknown", outcome: "error", platform: "telegram" });
  });

  it("версия запроса не 1 — тоже bad: ответ понимает только первая версия", async () => {
    const s = setup();
    const { account, ref } = await liveCard(s);
    expect(await s.query(account.platformUserId, ref, "v2:r")).toBe('{"v":1,"err":"bad"}');
  });

  it("bot.formats.enabled выключен — { v: 1, off: 1 }, исход off", async () => {
    const s = setup();
    const { account, ref } = await liveCard(s);
    s.panel.set("bot.formats.enabled", false);
    expect(await s.query(account.platformUserId, ref)).toBe('{"v":1,"off":1}');
    expect(lastQuery(s)).toMatchObject({ action: "refresh", outcome: "off" });
  });

  it("нет аккаунта и заблокированный аккаунт — err: auth", async () => {
    const s = setup();
    const { ref } = await liveCard(s);
    expect(await s.query("999999999", ref)).toBe('{"v":1,"err":"auth"}');
    expect(lastQuery(s)).toMatchObject({ action: "refresh", outcome: "error" });
    const banned = await s.player({ banned: true });
    expect(await s.query(banned.platformUserId, ref)).toBe('{"v":1,"err":"auth"}');
  });

  it("нет ссылки на сообщение или карточки по ней — { v: 1, x: 1 }; закрытая — тоже", async () => {
    const s = setup();
    const { account, row, ref } = await liveCard(s);
    expect(await s.query(account.platformUserId, null)).toBe('{"v":1,"x":1}');
    expect(await s.query(account.platformUserId, { chatId: "1", messageId: 99 })).toBe('{"v":1,"x":1}');
    expect(lastQuery(s)).toMatchObject({ outcome: "error" });
    await s.repository.close(row.id, T0);
    expect(await s.query(account.platformUserId, ref)).toBe('{"v":1,"x":1}');
    expect(lastQuery(s)).toMatchObject({ card: "season", outcome: "error" });
  });

  it("карточка другого аккаунта — err: foreign", async () => {
    const s = setup();
    const { ref } = await liveCard(s);
    const stranger = await s.player();
    expect(await s.query(stranger.platformUserId, ref)).toBe('{"v":1,"err":"foreign"}');
    expect(lastQuery(s)).toMatchObject({ outcome: "error" });
  });

  it("карточка вида, которого нет в реестре, — закрыта для игрока: { v: 1, x: 1 }", async () => {
    const s = setup();
    const { account, ref } = await liveCard(s);
    const emptied = new BotCardKinds();
    const answerer = new BotCardsAnswerer(s.panel, s.accounts, emptied, s.repository, { consume: async () => true }, s.service, { queried: async () => undefined } as unknown as BotCardEvents, s.redis as unknown as Redis);
    expect(await answerer.answer({ platform: "telegram", platformUserId: account.platformUserId, ref, data: "v1:r" })).toBe('{"v":1,"x":1}');
  });

  it("выключены bot.widget.enabled или ключ вида, либо стоит пауза площадки — { v: 1, off: 1 }", async () => {
    const s = setup();
    const { account, ref } = await liveCard(s);
    s.panel.set("bot.widget.enabled", false);
    expect(await s.query(account.platformUserId, ref)).toBe('{"v":1,"off":1}');
    expect(lastQuery(s)).toMatchObject({ card: "season", action: "refresh", outcome: "off" });
    s.panel.set("bot.widget.enabled", true);
    s.panel.set(SEASON_ENABLED.key, false);
    expect(await s.query(account.platformUserId, ref)).toBe('{"v":1,"off":1}');
    s.panel.set(SEASON_ENABLED.key, true);
    await s.service.pause("telegram");
    expect(await s.query(account.platformUserId, ref)).toBe('{"v":1,"off":1}');
    expect(s.limiter.calls).toEqual([]);
  });

  it("обновление: состояние вида с v: 1 и событие refresh/ok; лимит учтён по аккаунту — 300 в час", async () => {
    const s = setup();
    const { account, ref } = await liveCard(s);
    expect(await s.query(account.platformUserId, ref)).toBe('{"v":1,"place":3,"week":"2026-W46"}');
    expect(lastQuery(s)).toEqual({ card: "season", action: "refresh", outcome: "ok", platform: "telegram" });
    expect(s.limiter.calls).toEqual([{ rule: { scope: "bot-card", limit: 300, windowSec: 3600 }, key: account.accountId }]);
  });

  it("r второй раз за 30 секунд — без сборки состояния (кэш); через 30 секунд — снова собирается", async () => {
    const s = setup();
    const { account, ref } = await liveCard(s);
    await s.query(account.platformUserId, ref);
    const after = s.world.stateCalls;
    s.world.place = 1;
    expect(await s.query(account.platformUserId, ref)).toBe('{"v":1,"place":3,"week":"2026-W46"}');
    expect(s.world.stateCalls).toBe(after);
    vi.setSystemTime(new Date(T0.getTime() + 31_000));
    expect(await s.query(account.platformUserId, ref)).toBe('{"v":1,"place":1,"week":"2026-W46"}');
    expect(s.world.stateCalls).toBe(after + 1);
    expect(s.redis.has(`bot-card:state:${account.accountId}:season`)).toBe(true);
  });

  it("сверх лимита: r отвечает из кэша с stale: 1, а без кэша — { v: 1, stale: 1 }; действие — err: limited", async () => {
    const s = setup();
    const { account, ref } = await liveCard(s);
    s.limiter.allowed = false;
    expect(await s.query(account.platformUserId, ref)).toBe('{"v":1,"stale":1}');
    expect(lastQuery(s)).toMatchObject({ action: "refresh", outcome: "limited" });
    expect(s.world.stateCalls).toBe(1);

    s.limiter.allowed = true;
    await s.query(account.platformUserId, ref);
    s.limiter.allowed = false;
    expect(await s.query(account.platformUserId, ref)).toBe('{"v":1,"place":3,"week":"2026-W46","stale":1}');

    expect(await s.query(account.platformUserId, ref, "v1:claim")).toBe('{"v":1,"err":"limited"}');
    expect(lastQuery(s)).toEqual({ card: "season", action: "claim", outcome: "limited", platform: "telegram" });
  });

  it("действие не из kind.actions — err: bad", async () => {
    const s = setup();
    const { account, ref } = await liveCard(s);
    expect(await s.query(account.platformUserId, ref, "v1:hack")).toBe('{"v":1,"err":"bad"}');
    expect(lastQuery(s)).toMatchObject({ card: "season", action: "unknown", outcome: "error" });
  });

  it("вид без act при заявленном действии — err: bad, а не падение", async () => {
    const s = setup({}, { act: undefined });
    const { account, ref } = await liveCard(s);
    expect(await s.query(account.platformUserId, ref, "v1:claim")).toBe('{"v":1,"err":"bad"}');
  });

  it("действие: act получает аккаунт, действие и аргумент; ответ — { v: 1, res, ...result }; кэш состояния сброшен, правка карточки поставлена", async () => {
    const calls: unknown[] = [];
    const s = setup(
      {},
      {
        act: async (account, action, arg) => {
          calls.push({ account, action, arg });
          return { outcome: "ok", result: { coins: 20 } };
        },
      },
    );
    const { account, ref } = await liveCard(s);
    await s.query(account.platformUserId, ref);
    expect(s.redis.has(`bot-card:state:${account.accountId}:season`)).toBe(true);

    expect(await s.query(account.platformUserId, ref, "v1:claim:day-1")).toBe('{"v":1,"res":"ok","coins":20}');
    expect(calls).toEqual([{ account: { accountId: account.accountId, platform: "telegram", platformUserId: account.platformUserId }, action: "claim", arg: "day-1" }]);
    expect(lastQuery(s)).toEqual({ card: "season", action: "claim", outcome: "ok", platform: "telegram" });
    expect(s.redis.has(`bot-card:state:${account.accountId}:season`)).toBe(false);
    expect(s.queue.of("card-edit")).toHaveLength(1);
  });

  it.each(["already", "locked", "limited"] as const)("исход действия %s попадает в ответ и событие как есть", async (outcome) => {
    const s = setup({}, { act: async () => ({ outcome, result: {} }) });
    const { account, ref } = await liveCard(s);
    expect(await s.query(account.platformUserId, ref, "v1:claim")).toBe(`{"v":1,"res":"${outcome}"}`);
    expect(lastQuery(s)).toMatchObject({ action: "claim", outcome });
  });

  it("act бросает — err: error, исход error; в лог уходит без данных игрока", async () => {
    const s = setup({}, {
      act: async () => {
        throw new Error("кошелёк недоступен у 12345");
      },
    });
    const { account, ref } = await liveCard(s);
    expect(await s.query(account.platformUserId, ref, "v1:claim")).toBe('{"v":1,"err":"error"}');
    expect(lastQuery(s)).toMatchObject({ action: "claim", outcome: "error" });
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain(account.platformUserId);
  });

  it("act дольше 8 секунд — err: timeout, исход error", async () => {
    const s = setup({}, { act: () => new Promise(() => undefined) });
    const { account, ref } = await liveCard(s);
    const pending = s.query(account.platformUserId, ref, "v1:claim");
    await vi.advanceTimersByTimeAsync(7_999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await pending).toBe('{"v":1,"err":"timeout"}');
    expect(lastQuery(s)).toMatchObject({ action: "claim", outcome: "error" });
  });

  it("ответ длиннее 1024 байт — err: big, строка лога card_answer_too_big, исход error", async () => {
    const s = setup({}, { state: async () => ({ text: "я".repeat(600) }) });
    const { account, ref } = await oversizedCard(s);
    expect(await s.query(account.platformUserId, ref)).toBe('{"v":1,"err":"big"}');
    expect(warned("card_answer_too_big")).toBe(1);
    expect(lastQuery(s)).toMatchObject({ outcome: "error" });
  });

  it("сбой Redis при чтении кэша — состояние собирается заново, ответ есть", async () => {
    const s = setup();
    const { account, ref } = await liveCard(s);
    s.redis.down = true;
    expect(await s.query(account.platformUserId, ref)).toBe('{"v":1,"place":3,"week":"2026-W46"}');
  });

  it("ответ — всегда строка не длиннее 1024 байт, на любой запрос", async () => {
    const s = setup();
    const { account, ref } = await liveCard(s);
    for (const data of ["", "v1:r", "v1:claim", "v1:claim:x", "v9:r", "v1:r:a:b", "\u0000", "v1:" + "z".repeat(100)]) {
      const answer = await s.query(account.platformUserId, ref, data);
      expect(typeof answer).toBe("string");
      expect(Buffer.byteLength(answer)).toBeLessThanOrEqual(1024);
      expect(JSON.parse(answer)).toMatchObject({ v: 1 });
    }
  });

  /** Карточка в таблице без отправки: состояние вида разрастается уже после неё, и ответ на запрос не умещается в предел. */
  async function oversizedCard(s: Harness) {
    const account = await s.player();
    const row: BotCardRow = {
      id: randomUUID(),
      accountId: account.accountId,
      platform: "telegram",
      kind: "season",
      chatId: account.platformUserId,
      messageId: 50,
      version: "ab12cd34",
      periodKey: PERIOD_NOW,
      state: encodeState({ place: 3 }),
      stateHash: "x",
      createdAt: T0,
      updatedAt: T0,
      closedAt: null,
    };
    s.repository.rows.push(row);
    return { account, row, ref: refOf(row) };
  }
});

describe("очередь notifications-bot: задания карточек", () => {
  function queueWith() {
    const delivered: unknown[] = [];
    const sender = {
      deliver: async (job: unknown) => {
        delivered.push(job);
        return { status: "sent" };
      },
    };
    const queue = new BotNotifyQueue(CONFIG, {} as never, sender as never);
    const added: { name: string; data: unknown; options: Record<string, unknown> }[] = [];
    (queue as unknown as { queue: unknown }).queue = {
      add: async (name: string, data: unknown, options: Record<string, unknown>) => {
        added.push({ name, data, options });
      },
    };
    return { queue, added, delivered };
  }

  it("addPaced: jobId и задержка из аргументов, выполненное и упавшее задание не хранятся, три попытки с растущей паузой", async () => {
    const { queue, added } = queueWith();
    expect(await queue.addPaced("card-edit", { cardId: "c" }, { jobId: "card-edit-c", delayMs: 5_000 })).toBe(true);
    expect(added).toEqual([
      {
        name: "card-edit",
        data: { cardId: "c" },
        options: { jobId: "card-edit-c", delay: 5_000, attempts: 3, backoff: { type: "exponential", delay: 10_000 }, removeOnComplete: true, removeOnFail: true },
      },
    ]);
  });

  it("очередь не запущена (вход игроков выключен) — addPaced возвращает false, а не падает", async () => {
    const queue = new BotNotifyQueue(CONFIG, {} as never, {} as never);
    expect(await queue.addPaced("card-edit", {}, { jobId: "card-edit-c", delayMs: 0 })).toBe(false);
  });

  it("registerPaced: имя notify занято дублем, повтор имени — исключение", () => {
    const { queue } = queueWith();
    expect(() => queue.registerPaced("notify", async () => undefined)).toThrow();
    queue.registerPaced("card-edit", async () => undefined);
    expect(() => queue.registerPaced("card-edit", async () => undefined)).toThrow();
  });

  it("process по имени: задание карточки идёт в свой обработчик, а не к отправителю дубля", async () => {
    const { queue, delivered } = queueWith();
    const received: unknown[] = [];
    queue.registerPaced("card-edit", async (data) => {
      received.push(data);
    });
    await queue.process({ name: "card-edit", data: { cardId: "c" } });
    expect(received).toEqual([{ cardId: "c" }]);
    expect(delivered).toEqual([]);
  });

  it("process: notify и задание без имени идут к отправителю как раньше", async () => {
    const { queue, delivered } = queueWith();
    const data = { notificationId: randomUUID(), accountId: randomUUID(), kind: "team_message", payload: { text: "Привет" } };
    await queue.process({ name: "notify", data });
    await queue.process({ data });
    expect(delivered).toHaveLength(2);
  });

  it("process: незнакомое имя — выход без ошибки (задание не должно крутиться в повторах)", async () => {
    const { queue, delivered } = queueWith();
    await expect(queue.process({ name: "card-nope", data: {} })).resolves.toBeUndefined();
    expect(delivered).toEqual([]);
  });

  it("ошибка обработчика карточки летит наружу: BullMQ повторит задание", async () => {
    const { queue } = queueWith();
    queue.registerPaced("card-edit", async () => {
      throw new Error("площадка просит подождать");
    });
    await expect(queue.process({ name: "card-edit", data: {} })).rejects.toThrow("площадка просит подождать");
  });
});

describe("настройки карточек", () => {
  it("bot.widget.enabled по умолчанию выключен (Р225), остальные — 30 и 10 минут в своих коридорах", () => {
    expect(SETTINGS.botWidgetEnabled.key).toBe("bot.widget.enabled");
    expect(SETTINGS.botWidgetEnabled.fallback).toBe(false);
    expect(SETTINGS.botWidgetRetryMinutes).toMatchObject({ key: "bot.widget.retry-minutes", fallback: 30, range: { min: 5, max: 1440 } });
    expect(SETTINGS.botWidgetEditMinMinutes).toMatchObject({ key: "bot.widget.edit-min-minutes", fallback: 10, range: { min: 1, max: 120 } });
  });

  it("коридоры держит схема: пауза — 5…1440 минут, правка — 1…120", () => {
    const retry = SETTINGS.botWidgetRetryMinutes.schema;
    expect([retry.safeParse(4).success, retry.safeParse(5).success, retry.safeParse(1440).success, retry.safeParse(1441).success]).toEqual([false, true, true, false]);
    const edit = SETTINGS.botWidgetEditMinMinutes.schema;
    expect([edit.safeParse(0).success, edit.safeParse(1).success, edit.safeParse(120).success, edit.safeParse(121).success, edit.safeParse(2.5).success]).toEqual([false, true, true, false, false]);
  });

  it("все три — в группе «Сообщения бота»", () => {
    for (const setting of [SETTINGS.botWidgetEnabled, SETTINGS.botWidgetRetryMinutes, SETTINGS.botWidgetEditMinMinutes]) expect(setting.group).toBe("Сообщения бота");
  });
});

describe("модули", () => {
  const metadata = (key: string, target: Type<unknown>): unknown[] => (Reflect.getMetadata(key, target) as unknown[] | undefined) ?? [];

  it("BotCardsModule: подключает пять модулей и отдаёт виды, сервис и ответчика", () => {
    const imports = metadata("imports", BotCardsModule);
    for (const dependency of [AuthModule, MessagingModule, AccountSettingsModule, BotMessagesModule, NotificationsBotModule]) expect(imports).toContain(dependency);
    const exports = metadata("exports", BotCardsModule);
    expect(exports).toEqual(expect.arrayContaining([BotCardKinds, BotCardsService, LIVE_CARD_ANSWERER]));
    expect(exports).not.toContain(BotCardsAnswerer);
  });

  it("NotificationsBotModule отдаёт очередь, PlatformsModule — реестр карточек", () => {
    expect(metadata("exports", NotificationsBotModule)).toContain(BotNotifyQueue);
    expect(metadata("exports", PlatformsModule)).toContain(LiveCards);
  });
});
