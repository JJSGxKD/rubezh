import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "../src/common/domain-error.js";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { PaymentRetry } from "../src/modules/payments/payment-retry.js";
import { PurchaseActionUnavailableError, PurchaseNotFoundError } from "../src/modules/payments/payments-errors.js";
import { PaymentsHooks, type SupportAction } from "../src/modules/payments/payments-hooks.js";
import type { FailedPaymentJob, PaymentsQueue } from "../src/modules/payments/payments-queue.js";
import type { StoredPurchase } from "../src/modules/payments/purchase-types.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPurchasesRepository } from "./helpers/memory-purchases.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * «Повторить учёт» по покупке (tasks/T-0431, Р209, WP53): все брошенные
 * задания одной покупки повторяются разом. Очередь подменена, роли, аккаунты
 * и покупки — в памяти; закрепляется то, где такое действие ломается: покупка
 * без заданий, двойное нажатие, чужая и своя покупка.
 */

const NOW = new Date(Date.UTC(2026, 10, 12, 9, 30));
const OWNER_ID = "777000111";
const NOTE = "Игрок написал в поддержку: оплата не пришла";
const PURCHASE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PURCHASE_ID = "22222222-2222-4222-8222-222222222222";
const CHARGE_ID = "charge-abc";

const NOTHING_TO_RETRY = "Повторять нечего: брошенных заданий по этой покупке нет. Если звёзды списаны, а оплаты нет — запустите сверку с Telegram";

function config(env: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID, ...env } as NodeJS.ProcessEnv);
}

function failedJob(patch: Partial<FailedPaymentJob> = {}): FailedPaymentJob {
  return {
    jobId: "confirm-aaaa1111",
    kind: "confirm",
    chargeId: CHARGE_ID,
    purchaseId: PURCHASE_ID,
    payerId: "555000111",
    amount: 50,
    reason: "Connection terminated unexpectedly",
    attempts: 10,
    failedAt: new Date(NOW.getTime() - 600_000),
    ...patch,
  };
}

function purchase(accountId: string, patch: Partial<StoredPurchase> = {}): StoredPurchase {
  return {
    purchaseId: PURCHASE_ID,
    accountId,
    product: "shop_item",
    runId: null,
    continueNo: null,
    elapsedSec: null,
    sku: "starter_pack",
    priceStars: 50,
    chargedStars: 50,
    mode: "live",
    status: "paid",
    telegramChargeId: CHARGE_ID,
    invoicedAt: new Date(NOW.getTime() - 3_600_000),
    paidAt: new Date(NOW.getTime() - 3_000_000),
    refundReason: null,
    refundRequestedAt: null,
    refundedAt: null,
    fulfilledAt: null,
    renewalOf: null,
    ...patch,
  };
}

function setup(env: Record<string, string> = {}) {
  const cfg = config(env);
  const accounts = new MemoryAccountRepository();
  const rolesRepository = new MemoryRolesRepository();
  const roles = new RolesService(cfg, rolesRepository, accounts);
  const purchases = new MemoryPurchasesRepository();
  const hooks = new PaymentsHooks();
  const events: SupportAction[] = [];
  hooks.onSupport("тест", async (action) => {
    events.push(action);
  });

  /** Очередь-подмена: список брошенных (`null` — очереди нет), задания, которые уже не брошены, и что было повторено. */
  const queueState: { failed: FailedPaymentJob[] | null; notFailed: Set<string>; retried: string[]; asked: number[] } = { failed: [], notFailed: new Set(), retried: [], asked: [] };
  const queue = {
    failedJobs: async (limit: number) => {
      queueState.asked.push(limit);
      return queueState.failed;
    },
    // Как BullMQ: повторить можно только брошенное — второй вызов по тому же заданию отвечает «не брошено»
    retryFailed: async (jobId: string) => {
      if (queueState.notFailed.has(jobId)) return "not_failed";
      queueState.notFailed.add(jobId);
      queueState.retried.push(jobId);
      return "retried";
    },
  } as unknown as PaymentsQueue;

  const retry = new PaymentRetry(cfg, queue, purchases, roles, accounts, hooks);
  return { cfg, accounts, rolesRepository, roles, purchases, hooks, events, queueState, queue, retry };
}

type Setup = ReturnType<typeof setup>;

async function person(s: Setup, id: string, role?: "admin" | "moderator" | "game_designer", displayName = `Игрок ${id}`): Promise<AccountRef> {
  const account = await s.accounts.upsert({ platform: "telegram", platformUserId: id, displayName, username: null, photoUrl: null }, NOW.getTime());
  if (role !== undefined) await s.rolesRepository.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}

function put(s: Setup, row: StoredPurchase): StoredPurchase {
  s.purchases.rows.set(row.purchaseId, row);
  return row;
}

describe("PaymentRetry: «Повторить учёт»", () => {
  let s: Setup;
  let admin: AccountRef;
  let target: AccountRef;
  let logged: { level: string; event: string; fields: Record<string, unknown> }[];

  beforeEach(async () => {
    logged = [];
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        const fields = JSON.parse(String(message)) as Record<string, unknown>;
        logged.push({ level, event: String(fields.event), fields });
      });
    }
    s = setup();
    admin = await person(s, "900001", "admin", "Анна из поддержки");
    target = await person(s, "900002");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("у покупки два брошенных задания — подтверждение и возврат: оба повторены, журнал с двумя id, сообщение «повторено заданий: 2»", async () => {
    put(s, purchase(target.accountId));
    s.queueState.failed = [failedJob(), failedJob({ jobId: "refund-bbbb2222", kind: "refund", amount: null })];

    const result = await s.retry.retry(admin, PURCHASE_ID, NOTE, NOW);

    expect(result).toEqual({ retried: ["confirm-aaaa1111", "refund-bbbb2222"] });
    expect(s.queueState.retried).toEqual(["confirm-aaaa1111", "refund-bbbb2222"]);
    expect(s.queueState.asked).toEqual([1000]);
    expect(s.rolesRepository.entries).toHaveLength(1);
    expect(s.rolesRepository.entries[0]).toMatchObject({
      actorAccountId: admin.accountId,
      action: "payments.retry",
      target: target.accountId,
      after: { purchaseId: PURCHASE_ID, jobs: ["confirm-aaaa1111", "refund-bbbb2222"], note: NOTE },
    });
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({ kind: "retry", actorName: "Анна из поддержки", note: NOTE, at: NOW, detail: "повторено заданий: 2" });
    expect(s.events[0]?.purchase).toMatchObject({ purchaseId: PURCHASE_ID });
    expect(logged).toContainEqual({
      level: "log",
      event: "payment_retried",
      fields: expect.objectContaining({ module: "payments", purchaseId: PURCHASE_ID, jobs: 2, actorAccountId: admin.accountId }) as Record<string, unknown>,
    });
  });

  it("повторяются только задания этой покупки: чужое подтверждение и чужой внешний возврат остаются как были", async () => {
    put(s, purchase(target.accountId));
    s.queueState.failed = [
      failedJob({ jobId: "confirm-other0000", purchaseId: OTHER_PURCHASE_ID, chargeId: "charge-other" }),
      failedJob({ jobId: "refunded-cccc3333", kind: "refunded", purchaseId: null, chargeId: "charge-other" }),
      failedJob({ jobId: "confirm-mine0000" }),
    ];

    const result = await s.retry.retry(admin, PURCHASE_ID, NOTE, NOW);

    expect(result).toEqual({ retried: ["confirm-mine0000"] });
    expect(s.queueState.retried).toEqual(["confirm-mine0000"]);
  });

  it("внешний возврат находится по номеру оплаты покупки и повторяется вместе с остальными", async () => {
    put(s, purchase(target.accountId));
    s.queueState.failed = [failedJob({ jobId: "refunded-cccc3333", kind: "refunded", purchaseId: null, chargeId: CHARGE_ID })];

    const result = await s.retry.retry(admin, PURCHASE_ID, NOTE, NOW);

    expect(result).toEqual({ retried: ["refunded-cccc3333"] });
    expect(s.events[0]?.detail).toBe("повторено заданий: 1");
  });

  it("заданий нет — 409 с текстом, что делать дальше; журнала и сообщения нет", async () => {
    put(s, purchase(target.accountId));
    s.queueState.failed = [failedJob({ jobId: "confirm-other0000", purchaseId: OTHER_PURCHASE_ID, chargeId: "charge-other" })];

    const attempt = s.retry.retry(admin, PURCHASE_ID, NOTE, NOW);

    await expect(attempt).rejects.toBeInstanceOf(PurchaseActionUnavailableError);
    await expect(attempt).rejects.toMatchObject({ code: "purchase_action_unavailable", status: 409, message: NOTHING_TO_RETRY });
    expect(s.queueState.retried).toEqual([]);
    expect(s.rolesRepository.entries).toEqual([]);
    expect(s.events).toEqual([]);
  });

  it("очередь пуста — тот же отказ «Повторять нечего»", async () => {
    put(s, purchase(target.accountId));

    await expect(s.retry.retry(admin, PURCHASE_ID, NOTE, NOW)).rejects.toMatchObject({ message: NOTHING_TO_RETRY });
  });

  it("очереди нет — 409 «Очередь оплаты недоступна», а не «Повторять нечего»: заданий мы просто не видим", async () => {
    put(s, purchase(target.accountId));
    s.queueState.failed = null;

    const attempt = s.retry.retry(admin, PURCHASE_ID, NOTE, NOW);

    await expect(attempt).rejects.toBeInstanceOf(PurchaseActionUnavailableError);
    await expect(attempt).rejects.toMatchObject({ message: "Очередь оплаты недоступна: Redis не отвечает или оплата выключена" });
    expect(s.rolesRepository.entries).toEqual([]);
  });

  it("двойное нажатие: второй вызов видит not_failed у всех заданий — 409 «Задание уже повторяется», журнал и сообщение — один раз", async () => {
    put(s, purchase(target.accountId));
    // Список не меняется между вызовами: оба вызова прочитали его до чьего-либо повтора
    s.queueState.failed = [failedJob(), failedJob({ jobId: "refund-bbbb2222", kind: "refund", amount: null })];
    await s.retry.retry(admin, PURCHASE_ID, NOTE, NOW);

    const second = s.retry.retry(admin, PURCHASE_ID, NOTE, NOW);

    await expect(second).rejects.toBeInstanceOf(PurchaseActionUnavailableError);
    await expect(second).rejects.toMatchObject({ code: "purchase_action_unavailable", status: 409, message: "Задание уже повторяется" });
    expect(s.rolesRepository.entries).toHaveLength(1);
    expect(s.events).toHaveLength(1);
    expect(s.queueState.retried).toEqual(["confirm-aaaa1111", "refund-bbbb2222"]);
  });

  it("часть заданий уже повторена — повторяются остальные, журнал называет только их", async () => {
    put(s, purchase(target.accountId));
    s.queueState.failed = [failedJob(), failedJob({ jobId: "refund-bbbb2222", kind: "refund", amount: null })];
    s.queueState.notFailed.add("confirm-aaaa1111");

    const result = await s.retry.retry(admin, PURCHASE_ID, NOTE, NOW);

    expect(result).toEqual({ retried: ["refund-bbbb2222"] });
    expect(s.rolesRepository.entries[0]).toMatchObject({ after: { purchaseId: PURCHASE_ID, jobs: ["refund-bbbb2222"], note: NOTE } });
    expect(s.events[0]?.detail).toBe("повторено заданий: 1");
  });

  it("покупки нет — «Покупка не найдена», очередь не читается", async () => {
    await expect(s.retry.retry(admin, randomUUID(), NOTE, NOW)).rejects.toBeInstanceOf(PurchaseNotFoundError);

    expect(s.queueState.asked).toEqual([]);
    expect(s.rolesRepository.entries).toEqual([]);
  });

  it.each([["moderator" as const], ["game_designer" as const]])("чужой аккаунт: роль %s без payments.support — ForbiddenError, покупки и очередь не читаются", async (role) => {
    const weak = await person(s, `9100${role.length}`, role);
    put(s, purchase(target.accountId));
    s.queueState.failed = [failedJob()];
    const byId = vi.spyOn(s.purchases, "byId");

    await expect(s.retry.retry(weak, PURCHASE_ID, NOTE, NOW)).rejects.toBeInstanceOf(ForbiddenError);

    expect(byId).not.toHaveBeenCalled();
    expect(s.queueState.asked).toEqual([]);
    expect(s.queueState.retried).toEqual([]);
  });

  it("игрок без роли — ForbiddenError", async () => {
    put(s, purchase(target.accountId));
    s.queueState.failed = [failedJob()];

    await expect(s.retry.retry(target, PURCHASE_ID, NOTE, NOW)).rejects.toBeInstanceOf(ForbiddenError);

    expect(s.queueState.retried).toEqual([]);
  });

  it("своя покупка — отказ с понятным текстом, задания не трогаются", async () => {
    put(s, purchase(admin.accountId));
    s.queueState.failed = [failedJob()];

    const attempt = s.retry.retry(admin, PURCHASE_ID, NOTE, NOW);

    await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
    await expect(attempt).rejects.toMatchObject({ message: "Повторять учёт своей покупки нельзя" });
    expect(s.queueState.retried).toEqual([]);
    expect(s.rolesRepository.entries).toEqual([]);
  });

  it("со входом разработчика своя покупка повторяется: проверить на себе", async () => {
    const dev = setup({ NODE_ENV: "development", AUTH_DEV_LOGIN: "true" });
    const me = await person(dev, "900010", "admin");
    put(dev, purchase(me.accountId));
    dev.queueState.failed = [failedJob()];

    const result = await dev.retry.retry(me, PURCHASE_ID, NOTE, NOW);

    expect(result).toEqual({ retried: ["confirm-aaaa1111"] });
  });

  it("владелец (из списка окружения) повторяет учёт", async () => {
    const owner = await person(s, OWNER_ID);
    put(s, purchase(target.accountId));
    s.queueState.failed = [failedJob()];

    expect(await s.retry.retry(owner, PURCHASE_ID, NOTE, NOW)).toEqual({ retried: ["confirm-aaaa1111"] });
  });

  it("имени актёра нет в аккаунтах — в сообщении команде стоит его id", async () => {
    put(s, purchase(target.accountId));
    s.queueState.failed = [failedJob()];
    const stranger: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: OWNER_ID };

    await s.retry.retry(stranger, PURCHASE_ID, NOTE, NOW);

    expect(s.events[0]?.actorName).toBe(stranger.accountId);
  });

  it("слушатель сообщения упал — действие уже выполнено, ответ приходит как обычно", async () => {
    put(s, purchase(target.accountId));
    s.queueState.failed = [failedJob()];
    s.hooks.onSupport("сломанный", async () => {
      throw new Error("поток недоступен");
    });

    await expect(s.retry.retry(admin, PURCHASE_ID, NOTE, NOW)).resolves.toEqual({ retried: ["confirm-aaaa1111"] });
  });
});
