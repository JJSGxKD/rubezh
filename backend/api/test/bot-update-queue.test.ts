import { Logger } from "@nestjs/common";
import { UnrecoverableError } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { BotRouter, type DispatchResult } from "../src/platforms/telegram/bot-router.js";
import { BotUpdateQueue, isUrgent } from "../src/platforms/telegram/bot-update-queue.js";
import type { TelegramUpdate } from "../src/platforms/telegram/telegram-bot-api.js";
import { redisDatabase } from "./helpers/redis-database.js";

/**
 * Очередь обновлений бота (tasks/T-0027): обновление сначала записывается в
 * очередь `bot-updates`, потом Telegram получает «принято»; обрабатывает его
 * воркер, и упавший обработчик повторяется. Юнит-тесты — на подменах очереди и
 * маршрутизатора; сквозной — на настоящем BullMQ и Redis (адрес —
 * PLAYTEST_TEST_REDIS_URL, без него пропуск).
 */

function config(updates: "off" | "polling" | "webhook" = "polling", patch: Record<string, string> = {}): AppConfig {
  const secrets = updates === "webhook" ? { TELEGRAM_WEBHOOK_SECRET: "s3cret-webhook-token-0123456789abcdef" } : {};
  return loadAppConfig({ NODE_ENV: "test", TELEGRAM_BOT_TOKEN: "123456:TEST", TELEGRAM_BOT_UPDATES: updates, ...secrets, ...patch } as NodeJS.ProcessEnv);
}

function message(id: number, text = "/start"): TelegramUpdate {
  return { update_id: id, message: { message_id: id, date: 1, text, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false } } };
}

function preCheckout(id: number): TelegramUpdate {
  return { update_id: id, pre_checkout_query: { id: "q-1", from: { id: 7, is_bot: false }, currency: "XTR", total_amount: 3, invoice_payload: "p-1" } };
}

function successfulPayment(id: number): TelegramUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1,
      chat: { id: 7, type: "private" },
      from: { id: 7, is_bot: false },
      successful_payment: { currency: "XTR", total_amount: 3, invoice_payload: "p-1", telegram_payment_charge_id: "charge-1" },
    },
  };
}

interface Added {
  name: string;
  data: unknown;
  options: Record<string, unknown>;
}

/** Подмена `Queue.add` BullMQ: запоминает, что в очередь поставили. */
class FakeQueue {
  readonly added: Added[] = [];
  hang = false;
  failWith: Error | null = null;

  async add(name: string, data: unknown, options: Record<string, unknown>): Promise<void> {
    if (this.failWith !== null) throw this.failWith;
    if (this.hang) return await new Promise<void>(() => undefined);
    this.added.push({ name, data, options });
  }
}

function setup(result: DispatchResult = { status: "handled", handler: "all" }) {
  const dispatched: TelegramUpdate[] = [];
  const router = {
    dispatch: async (incoming: TelegramUpdate): Promise<DispatchResult> => {
      dispatched.push(incoming);
      return result;
    },
  } as unknown as BotRouter;
  const queue = new BotUpdateQueue(config(), router);
  const fake = new FakeQueue();
  Object.assign(queue as unknown as { queue: unknown }, { queue: fake });
  return { queue, fake, dispatched };
}

describe("срочные обновления", () => {
  it("предварительная проверка оплаты и успешная оплата срочные, остальное — нет", () => {
    expect(isUrgent(preCheckout(1))).toBe(true);
    expect(isUrgent(successfulPayment(2))).toBe(true);
    expect(isUrgent(message(3))).toBe(false);
  });

  it("возврат не срочный: ответа за десять секунд от него никто не ждёт", () => {
    const refunded: TelegramUpdate = {
      update_id: 4,
      message: {
        message_id: 4,
        date: 1,
        chat: { id: 7, type: "private" },
        refunded_payment: { currency: "XTR", total_amount: 3, invoice_payload: "p-1", telegram_payment_charge_id: "charge-1" },
      },
    };
    expect(isUrgent(refunded)).toBe(false);
  });
});

describe("постановка обновления в очередь", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("обычное сообщение: задание с id update-<update_id>, без приоритета", async () => {
    const { queue, fake } = setup();

    await queue.enqueue(message(101));

    expect(fake.added).toHaveLength(1);
    expect(fake.added[0]).toMatchObject({ name: "update", data: message(101), options: { jobId: "update-101" } });
    expect(fake.added[0]?.options).not.toHaveProperty("priority");
  });

  it.each([
    ["предварительная проверка оплаты", preCheckout(102)],
    ["успешная оплата", successfulPayment(103)],
  ])("%s идёт с приоритетом 1: оплата ждёт ответа десять секунд", async (_name, urgent) => {
    const { queue, fake } = setup();

    await queue.enqueue(urgent);

    expect(fake.added[0]?.options).toMatchObject({ jobId: `update-${String(urgent.update_id)}`, priority: 1 });
  });

  it("задание повторяется до пяти раз с растущей паузой; выполненное помнится час, упавшее — сутки", async () => {
    const { queue, fake } = setup();

    await queue.enqueue(message(104));

    expect(fake.added[0]?.options).toMatchObject({
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000, jitter: 0.5 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86_400 },
    });
  });

  it("повтор одного update_id получает тот же id задания: BullMQ второго не заведёт", async () => {
    const { queue, fake } = setup();

    await queue.enqueue(message(105));
    await queue.enqueue(message(105, "/help"));

    expect(fake.added.map((job) => job.options.jobId)).toEqual(["update-105", "update-105"]);
  });

  it("очередь не ответила за 2 секунды — enqueue бросает, и вебхук ответит 503", async () => {
    vi.useFakeTimers();
    const { queue, fake } = setup();
    fake.hang = true;

    const pending = queue.enqueue(message(106)).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(pending).resolves.toMatchObject({ message: expect.stringContaining("очередь обновлений бота") as string });
  });

  it("ошибка постановки (Redis недоступен) бросается вызывающему как есть", async () => {
    const { queue, fake } = setup();
    fake.failWith = new Error("Redis недоступен");

    await expect(queue.enqueue(message(107))).rejects.toThrow("Redis недоступен");
  });

  it("очереди нет — чтение обновлений выключено — enqueue бросает: молча терять обновление нельзя", async () => {
    const queue = new BotUpdateQueue(config("off"), { dispatch: async () => ({ status: "unhandled" }) } as unknown as BotRouter);
    await queue.onApplicationBootstrap();

    await expect(queue.enqueue(message(108))).rejects.toThrow();
  });
});

describe("задание воркера", () => {
  let logged: { level: string; event: string; fields: Record<string, unknown> }[];

  beforeEach(() => {
    logged = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((line: unknown) => {
        const fields = JSON.parse(String(line)) as Record<string, unknown>;
        logged.push({ level, event: String(fields.event), fields });
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("данные не по схеме: не бросает (повтор не поможет), в router не идёт, в логе bot_update_dropped", async () => {
    const { queue, dispatched } = setup();

    await expect(queue.process({ data: { update_id: "не число" }, attemptsMade: 0 })).resolves.toBeUndefined();
    await expect(queue.process({ data: null, attemptsMade: 0 })).resolves.toBeUndefined();

    expect(dispatched).toEqual([]);
    expect(logged.filter((entry) => entry.event === "bot_update_dropped")).toHaveLength(2);
    expect(logged.find((entry) => entry.event === "bot_update_dropped")).toMatchObject({ level: "warn" });
  });

  it("обработчик взял — задание выполнено", async () => {
    const { queue, dispatched } = setup({ status: "handled", handler: "start" });

    await expect(queue.process({ data: message(201), attemptsMade: 0 })).resolves.toBeUndefined();

    expect(dispatched).toEqual([message(201)]);
  });

  it("никто не взял — тоже выполнено: повторять нечего", async () => {
    const { queue } = setup({ status: "unhandled" });

    await expect(queue.process({ data: message(202), attemptsMade: 0 })).resolves.toBeUndefined();
  });

  it("обработчик упал — бросает, чтобы BullMQ повторил задание; в тексте — кто упал", async () => {
    const { queue } = setup({ status: "failed", handler: "welcome" });

    await expect(queue.process({ data: message(203), attemptsMade: 1 })).rejects.toThrow("обработчик welcome упал");
  });

  it("лишние поля обновления отсекаются схемой, как на входе вебхука", async () => {
    const { queue, dispatched } = setup();

    await queue.process({ data: { ...message(204), чужое: "поле" }, attemptsMade: 0 });

    expect(dispatched[0]).toEqual(message(204));
  });

  it("последняя попытка: в логе error bot_update_abandoned с update_id и причиной", async () => {
    const { queue } = setup();

    queue.jobFailed({ data: message(301), attemptsMade: 5, opts: { attempts: 5 } }, new Error("обработчик welcome упал"));

    expect(logged.filter((entry) => entry.event === "bot_update_abandoned")).toEqual([
      { level: "error", event: "bot_update_abandoned", fields: expect.objectContaining({ module: "bot", updateId: 301, reason: "обработчик welcome упал" }) as Record<string, unknown> },
    ]);
  });

  it("не последняя попытка — брошенным задание не называется: повтор ещё впереди", () => {
    const { queue } = setup();

    queue.jobFailed({ data: message(302), attemptsMade: 2, opts: { attempts: 5 } }, new Error("обработчик welcome упал"));

    expect(logged.map((entry) => entry.event)).not.toContain("bot_update_abandoned");
  });

  it("безнадёжная ошибка бросает задание сразу", () => {
    const { queue } = setup();

    queue.jobFailed({ data: message(303), attemptsMade: 1, opts: { attempts: 5 } }, new UnrecoverableError("не повторять"));

    expect(logged.map((entry) => entry.event)).toContain("bot_update_abandoned");
  });

  it("задание с повреждёнными данными тоже закрывается без падения, update_id в логе — пустой", () => {
    const { queue } = setup();

    expect(() => queue.jobFailed({ data: null, attemptsMade: 5, opts: { attempts: 5 } }, new Error("x"))).not.toThrow();
    expect(logged.find((entry) => entry.event === "bot_update_abandoned")?.fields).toMatchObject({ updateId: null });
  });
});

// Сквозной: настоящие BullMQ и Redis. Показывает то, чего подмены не покажут:
// повтор update_id не заводит второе задание, а обновление доходит до
// маршрутизатора через воркер.
const REDIS_URL = redisDatabase(process.env.PLAYTEST_TEST_REDIS_URL ?? "", 7);

describe.skipIf(REDIS_URL === "")("очередь обновлений бота на живом Redis", () => {
  let queue: BotUpdateQueue | null = null;

  afterEach(async () => {
    await queue?.onModuleDestroy();
    queue = null;
  });

  async function started(router: BotRouter) {
    const live = new BotUpdateQueue(config("polling", { REDIS_URL }), router);
    await live.onApplicationBootstrap();
    queue = live;
    return live;
  }

  /** Ждём, пока условие выполнится: воркер работает сам, по таймеру. */
  async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("условие не выполнилось за отведённое время");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("обновление доходит до маршрутизатора через воркер, а повтор update_id обрабатывается один раз", async () => {
    const id = 9_000_000 + Math.floor(Math.random() * 900_000);
    const seen: number[] = [];
    const router = {
      dispatch: async (incoming: TelegramUpdate): Promise<DispatchResult> => {
        seen.push(incoming.update_id);
        return { status: "handled", handler: "test" };
      },
    } as unknown as BotRouter;
    const live = await started(router);

    await live.enqueue(message(id));
    await live.enqueue(message(id, "/help"));
    await live.enqueue(message(id + 1));
    await until(() => seen.length >= 2);
    // Пауза: если бы повтор прошёл, он обработался бы за это время.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(seen.sort((a, b) => a - b)).toEqual([id, id + 1]);
  }, 20_000);

  it("Redis недоступен — enqueue бросает, а не теряет обновление", async () => {
    const live = new BotUpdateQueue(config("polling", { REDIS_URL: "redis://127.0.0.1:1" }), { dispatch: async () => ({ status: "unhandled" }) } as unknown as BotRouter);
    await live.onApplicationBootstrap();
    queue = live;

    await expect(live.enqueue(message(9_999_999))).rejects.toThrow();
  }, 20_000);
});
