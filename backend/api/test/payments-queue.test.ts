import { createHash, randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { UnrecoverableError } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PaymentConfirmation, ConfirmedPayment } from "../src/modules/payments/payment-confirmation.js";
import { PaymentRefunds } from "../src/modules/payments/payment-refunds.js";
import { PaymentsHooks, type AbandonedJob } from "../src/modules/payments/payments-hooks.js";
import { PaymentsQueue, type FailedPaymentJob } from "../src/modules/payments/payments-queue.js";
import { PurchaseFulfillment } from "../src/modules/payments/purchase-fulfillment.js";
import type { RefundOrder } from "../src/modules/payments/purchases.repository.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { starsProviders } from "./helpers/fake-stars-api.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryPurchasesRepository } from "./helpers/memory-purchases.js";

/**
 * Очередь оплаты без BullMQ и Redis: внешний возврат (`refunded_payment`)
 * ложится в неё, как и подтверждение, а задание, брошенное после всех
 * попыток, выходит слушателям (tasks/T-0004). Брошенные задания читаются и
 * повторяются из панели (tasks/T-0431, Р209, WP53).
 */

const NOW = Date.UTC(2026, 9, 6, 9, 5, 0);

function config(): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, TELEGRAM_BOT_UPDATES: "polling", PAYMENTS_ENABLED: "true" } as NodeJS.ProcessEnv);
}

const fingerprintOf = (chargeId: string): string => createHash("sha256").update(chargeId).digest("hex").slice(0, 32);

interface RecordedAdd {
  name: string;
  data: unknown;
  jobId: string | undefined;
}

function setup(recordRefunded: (chargeId: string, at: number | undefined) => Promise<void> = async () => undefined) {
  const hooks = new PaymentsHooks();
  const abandoned: AbandonedJob[] = [];
  hooks.onAbandoned("test", async (job) => void abandoned.push(job));
  const confirmation = { refunded: recordRefunded } as unknown as PaymentConfirmation;
  const purchases = new MemoryPurchasesRepository();
  const queue = new PaymentsQueue(config(), confirmation, new PaymentRefunds(purchases, starsProviders()), new RunsHooks(), starsProviders(), new PurchaseFulfillment(), purchases, hooks);

  /** Подмена очереди BullMQ: запоминает, что в неё добавили, как в неё добавил бы `Queue.add`. */
  const added: RecordedAdd[] = [];
  function attachQueue(): void {
    const fake = {
      add: async (name: string, data: unknown, options: { jobId?: string }) => void added.push({ name, data, jobId: options.jobId }),
    };
    Object.assign(queue as unknown as { queue: unknown }, { queue: fake });
  }
  return { queue, hooks, abandoned, added, attachQueue };
}

describe("внешний возврат через очередь", () => {
  let logged: { level: string; event: string; fields: Record<string, unknown> }[];

  beforeEach(() => {
    logged = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        const fields = JSON.parse(String(message)) as Record<string, unknown>;
        logged.push({ level, event: String(fields.event), fields });
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("задание refunded зовёт запись возврата с тем же chargeId и временем", async () => {
    const calls: [string, number | undefined][] = [];
    const { queue } = setup(async (chargeId, at) => void calls.push([chargeId, at]));

    await queue.process({ data: { kind: "refunded", chargeId: "charge-1", at: NOW } });

    expect(calls).toEqual([["charge-1", NOW]]);
  });

  it("без очереди refunded() выполняет запись сразу, со временем вызова", async () => {
    const calls: [string, number | undefined][] = [];
    const { queue } = setup(async (chargeId, at) => void calls.push([chargeId, at]));

    await queue.refunded("charge-1", NOW);

    expect(calls).toEqual([["charge-1", NOW]]);
  });

  it("время вызова по умолчанию — сейчас, а не ноль", async () => {
    const calls: (number | undefined)[] = [];
    const { queue } = setup(async (_chargeId, at) => void calls.push(at));
    const before = Date.now();

    await queue.refunded("charge-1");

    expect(calls[0]).toBeGreaterThanOrEqual(before);
    expect(calls[0]).toBeLessThanOrEqual(Date.now());
  });

  it("ошибка записи не пробивается наружу и пишет refund_unrecorded с chargeId и причиной", async () => {
    const { queue } = setup(async () => {
      throw new Error("база недоступна");
    });

    await expect(queue.refunded("charge-1", NOW)).resolves.toBeUndefined();

    expect(logged).toContainEqual({
      level: "error",
      event: "refund_unrecorded",
      fields: expect.objectContaining({ module: "payments", kind: "refunded", chargeId: "charge-1", reason: "база недоступна" }) as Record<string, unknown>,
    });
  });

  it("в очередь ложится задание вида refunded с идентификатором refunded-<отпечаток>", async () => {
    const { queue, added, attachQueue } = setup();
    attachQueue();

    await queue.refunded("charge:1", NOW);

    expect(added).toEqual([{ name: "refunded", data: { kind: "refunded", chargeId: "charge:1", at: NOW }, jobId: `refunded-${fingerprintOf("charge:1")}` }]);
  });

  it("повтор того же обновления получает тот же идентификатор: второго задания не заводится", async () => {
    const { queue, added, attachQueue } = setup();
    attachQueue();

    await queue.refunded("charge-1", NOW);
    await queue.refunded("charge-1", NOW + 5_000);
    await queue.refunded("charge-2", NOW);

    expect(added[0]?.jobId).toBe(added[1]?.jobId);
    expect(added[2]?.jobId).not.toBe(added[0]?.jobId);
  });

  it("идентификатор возврата не совпадает с идентификатором подтверждения той же оплаты", async () => {
    const { queue, added, attachQueue } = setup();
    attachQueue();
    const payment: ConfirmedPayment = { platform: "telegram", chargeId: "charge-1", payload: randomUUID(), payerId: "555", currency: "XTR", totalAmount: 3 };

    await queue.confirm(payment);
    await queue.refunded("charge-1", NOW);

    expect(added.map((job) => job.jobId)).toEqual([`confirm-${fingerprintOf("charge-1")}`, `refunded-${fingerprintOf("charge-1")}`]);
  });
});

describe("задание, брошенное после всех попыток", () => {
  const refundOrder: RefundOrder = {
    platform: "telegram",
    chargeId: "charge-9",
    purchaseId: "99999999-9999-4999-8999-999999999999",
    payerId: "555",
    reason: "unused",
  };

  beforeEach(() => {
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function failedJob(data: Parameters<PaymentsQueue["jobFailed"]>[0]["data"], attemptsMade: number, attempts = 10) {
    return { id: "job-1", data, attemptsMade, opts: { attempts } };
  }

  it("последняя попытка внешнего возврата: слушатель получает вид, оплату, причину и покупку null", async () => {
    const { queue, abandoned } = setup();

    await queue.jobFailed(failedJob({ kind: "refunded", chargeId: "charge-1", at: NOW }, 10), new Error("база лежит"));

    expect(abandoned).toEqual([{ jobId: "job-1", kind: "refunded", chargeId: "charge-1", purchaseId: null, reason: "база лежит" }]);
  });

  it("брошенное подтверждение несёт id покупки из счёта", async () => {
    const { queue, abandoned } = setup();
    const purchaseId = randomUUID();
    const payment: ConfirmedPayment = { platform: "telegram", chargeId: "charge-2", payload: purchaseId, payerId: "555", currency: "XTR", totalAmount: 3 };

    await queue.jobFailed(failedJob({ kind: "confirm", payment }, 10), new Error("запись не прошла"));

    expect(abandoned).toEqual([{ jobId: "job-1", kind: "confirm", chargeId: "charge-2", purchaseId, reason: "запись не прошла" }]);
  });

  it("брошенный заказанный возврат несёт оплату и покупку заказа", async () => {
    const { queue, abandoned } = setup();

    await queue.jobFailed(failedJob({ kind: "refund", order: refundOrder }, 10), new Error("Telegram недоступен"));

    expect(abandoned).toEqual([{ jobId: "job-1", kind: "refund", chargeId: "charge-9", purchaseId: "99999999-9999-4999-8999-999999999999", reason: "Telegram недоступен" }]);
  });

  it("не последняя попытка — слушателей не зовёт: повтор ещё впереди", async () => {
    const { queue, abandoned } = setup();

    await queue.jobFailed(failedJob({ kind: "refunded", chargeId: "charge-1", at: NOW }, 3), new Error("база лежит"));

    expect(abandoned).toEqual([]);
  });

  it("безнадёжная ошибка бросает задание сразу, не дожидаясь десятой попытки", async () => {
    const { queue, abandoned } = setup();

    await queue.jobFailed(failedJob({ kind: "refunded", chargeId: "charge-1", at: NOW }, 1), new UnrecoverableError("не повторять"));

    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.reason).toBe("не повторять");
  });

  it("задание без id слушателям уходит с пустым jobId, а не падает", async () => {
    const { queue, abandoned } = setup();

    await queue.jobFailed({ id: undefined, data: { kind: "refunded", chargeId: "charge-1", at: NOW }, attemptsMade: 10, opts: { attempts: 10 } }, new Error("x"));

    expect(abandoned[0]?.jobId).toBe("");
  });

  it("упавший слушатель не бросает наружу и не мешает остальным", async () => {
    const { queue, hooks, abandoned } = setup();
    hooks.onAbandoned("broken", async () => {
      throw new Error("слушатель упал");
    });

    await expect(queue.jobFailed(failedJob({ kind: "refunded", chargeId: "charge-1", at: NOW }, 10), new Error("база лежит"))).resolves.toBeUndefined();

    expect(abandoned).toHaveLength(1);
  });
});

/** Задание очереди, каким его отдаёт BullMQ: только то, что читает очередь оплаты. */
interface FakeBullJob {
  id?: string;
  data: unknown;
  failedReason?: string;
  attemptsMade: number;
  finishedOn?: number;
}

describe("брошенные задания: чтение", () => {
  const PURCHASE_ID = "11111111-1111-4111-8111-111111111111";
  const payment: ConfirmedPayment = { platform: "telegram", chargeId: "charge-1", payload: PURCHASE_ID, payerId: "555000111", currency: "XTR", totalAmount: 50 };
  const order: RefundOrder = { platform: "telegram", chargeId: "charge-2", purchaseId: PURCHASE_ID, payerId: "555000111", reason: "manual" };

  const confirmJob: FakeBullJob = { id: "confirm-aaaa", data: { kind: "confirm", payment }, failedReason: "Connection terminated", attemptsMade: 10, finishedOn: NOW };
  const refundJob: FakeBullJob = { id: "refund-bbbb", data: { kind: "refund", order }, failedReason: "Telegram недоступен", attemptsMade: 10, finishedOn: NOW - 60_000 };
  const refundedJob: FakeBullJob = { id: "refunded-cccc", data: { kind: "refunded", chargeId: "charge-3", at: NOW }, failedReason: "база лежит", attemptsMade: 4, finishedOn: NOW - 120_000 };

  function attach(queue: PaymentsQueue, getFailed: (start: number, end: number) => Promise<FakeBullJob[]>): void {
    Object.assign(queue as unknown as { queue: unknown }, { queue: { getFailed } });
  }

  it("три задания разных видов и одно с битыми данными — четыре строки; у битого вид unknown и пустые поля", async () => {
    const { queue } = setup();
    const broken: FakeBullJob = { id: "mystery-dddd", data: { kind: "что-то новое" }, attemptsMade: 3 };
    attach(queue, async () => [confirmJob, refundJob, refundedJob, broken]);

    const jobs = await queue.failedJobs(200);

    expect(jobs).toEqual([
      { jobId: "confirm-aaaa", kind: "confirm", chargeId: "charge-1", purchaseId: PURCHASE_ID, payerId: "555000111", amount: 50, reason: "Connection terminated", attempts: 10, failedAt: new Date(NOW) },
      { jobId: "refund-bbbb", kind: "refund", chargeId: "charge-2", purchaseId: PURCHASE_ID, payerId: "555000111", amount: null, reason: "Telegram недоступен", attempts: 10, failedAt: new Date(NOW - 60_000) },
      { jobId: "refunded-cccc", kind: "refunded", chargeId: "charge-3", purchaseId: null, payerId: null, amount: null, reason: "база лежит", attempts: 4, failedAt: new Date(NOW - 120_000) },
      { jobId: "mystery-dddd", kind: "unknown", chargeId: null, purchaseId: null, payerId: null, amount: null, reason: "", attempts: 3, failedAt: null },
    ] satisfies FailedPaymentJob[]);
  });

  it.each([[null], ["текст вместо объекта"], [42], [{ kind: 7 }], [{ kind: "возврат" }]])("данные %j не разбираются — вид unknown, поля пусты, строка не пропадает", async (data) => {
    const { queue } = setup();
    attach(queue, async () => [{ id: "mystery-eeee", data, failedReason: "x", attemptsMade: 1 }]);

    const [job] = (await queue.failedJobs(10)) ?? [];

    expect(job).toMatchObject({ jobId: "mystery-eeee", kind: "unknown", chargeId: null, purchaseId: null, payerId: null, amount: null });
  });

  it("известный вид с неполными данными остаётся своим видом, пустым остаётся только то, чего нет", async () => {
    const { queue } = setup();
    attach(queue, async () => [
      { id: "confirm-ffff", data: { kind: "confirm", payment: { chargeId: "charge-9", payload: 7, totalAmount: "много" } }, failedReason: "x", attemptsMade: 2 },
      { id: "refund-gggg", data: { kind: "refund" }, failedReason: "x", attemptsMade: 2 },
      // возврат без покупки: заказ «ничей», покупки в нём нет
      { id: "refund-hhhh", data: { kind: "refund", order: { ...order, purchaseId: null } }, failedReason: "x", attemptsMade: 2 },
    ]);

    const jobs = await queue.failedJobs(10);

    expect(jobs?.[0]).toMatchObject({ kind: "confirm", chargeId: "charge-9", purchaseId: null, payerId: null, amount: null });
    expect(jobs?.[1]).toMatchObject({ kind: "refund", chargeId: null, purchaseId: null });
    expect(jobs?.[2]).toMatchObject({ kind: "refund", chargeId: "charge-2", purchaseId: null });
  });

  it("причина — первая непустая строка, а не весь стек", async () => {
    const { queue } = setup();
    attach(queue, async () => [{ ...confirmJob, failedReason: "\n  \r\nPrisma: нет связи с базой\n    at Object.<anonymous> (file.js:1:1)\nвторая строка" }]);

    const [job] = (await queue.failedJobs(10)) ?? [];

    expect(job?.reason).toBe("Prisma: нет связи с базой");
  });

  it("причина длиннее 200 знаков обрезается по знакам, а не по кодовым единицам; нет причины — пустая строка", async () => {
    const { queue } = setup();
    attach(queue, async () => [
      { ...confirmJob, failedReason: "ж".repeat(300) },
      { ...confirmJob, id: "confirm-iiii", failedReason: "😀".repeat(250) },
      { ...confirmJob, id: "confirm-jjjj", failedReason: undefined },
    ]);

    const jobs = await queue.failedJobs(10);

    expect(jobs?.[0]?.reason).toBe("ж".repeat(200));
    expect(jobs?.[1]?.reason).toBe("😀".repeat(200));
    expect(jobs?.[2]?.reason).toBe("");
  });

  it("задание без времени завершения — failedAt null, без id — пустой jobId", async () => {
    const { queue } = setup();
    attach(queue, async () => [{ data: confirmJob.data, failedReason: "x", attemptsMade: 10 }]);

    const [job] = (await queue.failedJobs(10)) ?? [];

    expect(job).toMatchObject({ jobId: "", failedAt: null });
  });

  it("из очереди просится ровно лимит заданий: от нуля до лимита минус один", async () => {
    const { queue } = setup();
    const asked: [number, number][] = [];
    attach(queue, async (start, end) => {
      asked.push([start, end]);
      return [];
    });

    await queue.failedJobs(200);

    expect(asked).toEqual([[0, 199]]);
  });

  it("очереди нет (оплата выключена или Redis не поднят) — null, а не пустой список", async () => {
    const { queue } = setup();

    expect(await queue.failedJobs(200)).toBeNull();
  });

  it("очередь не отвечает — ошибка с названием вызова через 5 секунд, а не вечное ожидание", async () => {
    vi.useFakeTimers();
    try {
      const { queue } = setup();
      attach(queue, () => new Promise<FakeBullJob[]>(() => undefined));

      const result = expect(queue.failedJobs(10)).rejects.toThrow("брошенные задания оплаты");
      await vi.advanceTimersByTimeAsync(5_000);

      await result;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("брошенные задания: повтор", () => {
  beforeEach(() => {
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  interface FakeJob {
    getState: () => Promise<string>;
    retry: (state: string, options: unknown) => Promise<void>;
  }

  function attach(queue: PaymentsQueue, getJob: (jobId: string) => Promise<FakeJob | undefined>): void {
    Object.assign(queue as unknown as { queue: unknown }, { queue: { getJob } });
  }

  it("задания нет (его уже убрали из хранилища) — not_found", async () => {
    const { queue } = setup();
    const asked: string[] = [];
    attach(queue, async (jobId) => {
      asked.push(jobId);
      return undefined;
    });

    expect(await queue.retryFailed("confirm-aaaa")).toBe("not_found");
    expect(asked).toEqual(["confirm-aaaa"]);
  });

  it.each([["completed"], ["waiting"], ["active"], ["delayed"]])("задание в состоянии %s — not_failed, повтор не зовётся", async (state) => {
    const { queue } = setup();
    const retry = vi.fn(async () => undefined);
    attach(queue, async () => ({ getState: async () => state, retry }));

    expect(await queue.retryFailed("confirm-aaaa")).toBe("not_failed");
    expect(retry).not.toHaveBeenCalled();
  });

  it("брошенное задание повторяется со свежей серией попыток: оба счётчика сбрасываются", async () => {
    const { queue } = setup();
    const retry = vi.fn(async () => undefined);
    attach(queue, async () => ({ getState: async () => "failed", retry }));

    expect(await queue.retryFailed("confirm-aaaa")).toBe("retried");

    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith("failed", { resetAttemptsMade: true, resetAttemptsStarted: true });
  });

  it("BullMQ отказал в повторе — задание успели повторить до нас: not_failed, а не ошибка запроса", async () => {
    const { queue } = setup();
    attach(queue, async () => ({
      getState: async () => "failed",
      retry: async () => {
        throw new Error("Job confirm-aaaa is not in the failed state. retryJob");
      },
    }));

    expect(await queue.retryFailed("confirm-aaaa")).toBe("not_failed");
  });

  it("очереди нет — not_found: повторять нечего", async () => {
    const { queue } = setup();

    expect(await queue.retryFailed("confirm-aaaa")).toBe("not_found");
  });
});

describe("брошенные задания: состояние без изменений", () => {
  beforeEach(() => {
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  interface StateJob {
    getState: () => Promise<string>;
    retry: () => Promise<void>;
  }

  function attach(queue: PaymentsQueue, getJob: (jobId: string) => Promise<StateJob | undefined>): void {
    Object.assign(queue as unknown as { queue: unknown }, { queue: { getJob } });
  }

  it("очереди нет — not_found: спросить не у кого", async () => {
    const { queue } = setup();

    expect(await queue.jobState("confirm-aaaa")).toBe("not_found");
  });

  it("задания нет в хранилище — not_found", async () => {
    const { queue } = setup();
    const asked: string[] = [];
    attach(queue, async (jobId) => {
      asked.push(jobId);
      return undefined;
    });

    expect(await queue.jobState("confirm-aaaa")).toBe("not_found");
    expect(asked).toEqual(["confirm-aaaa"]);
  });

  it("брошенное задание — failed", async () => {
    const { queue } = setup();
    attach(queue, async () => ({ getState: async () => "failed", retry: async () => undefined }));

    expect(await queue.jobState("confirm-aaaa")).toBe("failed");
  });

  it.each([["completed"], ["waiting"], ["active"], ["delayed"], ["prioritized"], ["waiting-children"]])("повторённое или выполненное задание (%s) — not_failed", async (state) => {
    const { queue } = setup();
    attach(queue, async () => ({ getState: async () => state, retry: async () => undefined }));

    expect(await queue.jobState("confirm-aaaa")).toBe("not_failed");
  });

  it("состояние «unknown» (задание убрали, пока его читали) — not_found", async () => {
    const { queue } = setup();
    attach(queue, async () => ({ getState: async () => "unknown", retry: async () => undefined }));

    expect(await queue.jobState("confirm-aaaa")).toBe("not_found");
  });

  it("только читает: повтор не зовётся ни для какого состояния", async () => {
    const { queue } = setup();
    const retry = vi.fn(async () => undefined);
    for (const state of ["failed", "completed", "waiting"]) {
      attach(queue, async () => ({ getState: async () => state, retry }));
      await queue.jobState("confirm-aaaa");
    }

    expect(retry).not.toHaveBeenCalled();
  });

  it("Redis не ответил за 5 с — ошибка с названием вызова, а не вечное ожидание", async () => {
    vi.useFakeTimers();
    try {
      const { queue } = setup();
      attach(queue, () => new Promise<StateJob | undefined>(() => undefined));

      const assertion = expect(queue.jobState("confirm-aaaa")).rejects.toThrow("задание оплаты");
      await vi.advanceTimersByTimeAsync(5_000);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("подтверждение со временем и повтор по выписке (tasks/T-0434, Р209, WP53)", () => {
  const PURCHASE_ID = "11111111-1111-4111-8111-111111111111";
  const AT = NOW - 3_600_000;
  const payment: ConfirmedPayment = { platform: "telegram", chargeId: "charge:1", payload: PURCHASE_ID, payerId: "555000111", currency: "XTR", totalAmount: 50 };

  /** Подтверждение подставное и записывает, с чем его позвали; результат — выданная покупка: дальше очереди делать нечего. */
  function confirming() {
    const confirmed: unknown[][] = [];
    const refunded: unknown[][] = [];
    const confirmation = {
      confirm: async (...args: unknown[]) => {
        confirmed.push(args);
        return { kind: "duplicate", purchase: { fulfilledAt: new Date(NOW) } };
      },
      refunded: async (...args: unknown[]) => void refunded.push(args),
    } as unknown as PaymentConfirmation;
    const purchases = new MemoryPurchasesRepository();
    const queue = new PaymentsQueue(config(), confirmation, new PaymentRefunds(purchases, starsProviders()), new RunsHooks(), starsProviders(), new PurchaseFulfillment(), purchases, new PaymentsHooks());
    const added: RecordedAdd[] = [];
    function attachQueue(): void {
      const fake = { add: async (name: string, data: unknown, options: { jobId?: string }) => void added.push({ name, data, jobId: options.jobId }) };
      Object.assign(queue as unknown as { queue: unknown }, { queue: fake });
    }
    return { queue, confirmed, refunded, added, attachQueue };
  }

  let logged: { level: string; event: string; fields: Record<string, unknown> }[];

  beforeEach(() => {
    logged = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        const fields = JSON.parse(String(message)) as Record<string, unknown>;
        logged.push({ level, event: String(fields.event), fields });
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("confirm(payment, at) кладёт время прихода обновления в задание", async () => {
    const { queue, added, attachQueue } = confirming();
    attachQueue();

    await queue.confirm(payment, AT);

    expect(added).toEqual([{ name: "confirm", data: { kind: "confirm", payment, at: AT }, jobId: `confirm-${fingerprintOf("charge:1")}` }]);
  });

  it("время по умолчанию — момент вызова, а не ноль: обычное подтверждение от бота несёт время прихода", async () => {
    const { queue, added, attachQueue } = confirming();
    attachQueue();
    const before = Date.now();

    await queue.confirm(payment);

    const data = added[0]?.data as { at?: number } | undefined;
    expect(data?.at).toBeGreaterThanOrEqual(before);
    expect(data?.at).toBeLessThanOrEqual(Date.now());
  });

  it("process с временем зовёт confirmation.confirm(payment, at): оплата записывается временем оплаты, а не временем повтора", async () => {
    const { queue, confirmed } = confirming();

    await queue.process({ data: { kind: "confirm", payment, at: AT } });

    expect(confirmed).toStrictEqual([[payment, AT]]);
  });

  it("старое задание без времени — confirm(payment, undefined): запись временем обработки, как раньше", async () => {
    const { queue, confirmed } = confirming();

    await queue.process({ data: { kind: "confirm", payment } });

    expect(confirmed).toStrictEqual([[payment, undefined]]);
  });

  it("без очереди confirm(payment, at) выполняется сразу и с тем же временем", async () => {
    const { queue, confirmed } = confirming();

    await queue.confirm(payment, AT);

    expect(confirmed).toStrictEqual([[payment, AT]]);
  });

  it("replay подтверждения: идентификатор confirm-<отпечаток>-reconcile, в задании — время операции площадки", async () => {
    const { queue, added, attachQueue } = confirming();
    attachQueue();

    await queue.replay({ kind: "confirm", payment, at: AT }, "reconcile");

    expect(added).toEqual([{ name: "confirm", data: { kind: "confirm", payment, at: AT }, jobId: `confirm-${fingerprintOf("charge:1")}-reconcile` }]);
  });

  it("replay возврата: идентификатор refunded-<отпечаток>-reconcile", async () => {
    const { queue, added, attachQueue } = confirming();
    attachQueue();

    await queue.replay({ kind: "refunded", chargeId: "charge:1", at: AT }, "reconcile");

    expect(added).toEqual([{ name: "refunded", data: { kind: "refunded", chargeId: "charge:1", at: AT }, jobId: `refunded-${fingerprintOf("charge:1")}-reconcile` }]);
  });

  it("идентификатор повтора не совпадает с идентификатором прежнего задания той же оплаты: BullMQ не отбросит его как дубль", async () => {
    const { queue, added, attachQueue } = confirming();
    attachQueue();

    await queue.confirm(payment, AT);
    await queue.replay({ kind: "confirm", payment, at: AT }, "reconcile");

    expect(added).toHaveLength(2);
    expect(added[0]?.jobId).not.toBe(added[1]?.jobId);
  });

  it("без очереди replay выполняет запись сразу: подтверждение — со временем операции, возврат — с ним же", async () => {
    const { queue, confirmed, refunded } = confirming();

    await queue.replay({ kind: "confirm", payment, at: AT }, "reconcile");
    await queue.replay({ kind: "refunded", chargeId: "charge:1", at: AT }, "reconcile");

    expect(confirmed).toStrictEqual([[payment, AT]]);
    expect(refunded).toStrictEqual([["charge:1", AT]]);
  });

  it("ошибка записи при replay не пробивается наружу — в лог со всеми полями оплаты, как у обычного задания", async () => {
    const confirmation = {
      confirm: async () => {
        throw new Error("база недоступна");
      },
    } as unknown as PaymentConfirmation;
    const purchases = new MemoryPurchasesRepository();
    const queue = new PaymentsQueue(config(), confirmation, new PaymentRefunds(purchases, starsProviders()), new RunsHooks(), starsProviders(), new PurchaseFulfillment(), purchases, new PaymentsHooks());

    await expect(queue.replay({ kind: "confirm", payment, at: AT }, "reconcile")).resolves.toBeUndefined();

    expect(logged).toContainEqual({
      level: "error",
      event: "payment_unrecorded",
      fields: expect.objectContaining({ module: "payments", kind: "confirm", chargeId: "charge:1", purchaseId: PURCHASE_ID, reason: "база недоступна" }) as Record<string, unknown>,
    });
  });
});
