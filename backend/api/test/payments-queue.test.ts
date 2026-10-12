import { createHash, randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { UnrecoverableError } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { PaymentConfirmation, ConfirmedPayment } from "../src/modules/payments/payment-confirmation.js";
import { PaymentRefunds } from "../src/modules/payments/payment-refunds.js";
import { PaymentsHooks, type AbandonedJob } from "../src/modules/payments/payments-hooks.js";
import { PaymentsQueue } from "../src/modules/payments/payments-queue.js";
import { PurchaseFulfillment } from "../src/modules/payments/purchase-fulfillment.js";
import type { RefundOrder } from "../src/modules/payments/purchases.repository.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { starsProviders } from "./helpers/fake-stars-api.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryPurchasesRepository } from "./helpers/memory-purchases.js";

/**
 * Очередь оплаты без BullMQ и Redis: внешний возврат (`refunded_payment`)
 * ложится в неё, как и подтверждение, а задание, брошенное после всех
 * попыток, выходит слушателям (tasks/T-0004).
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
