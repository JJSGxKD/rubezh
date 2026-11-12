import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION_METADATA } from "../src/common/access.js";
import { ForbiddenError, RateLimitedError, ValidationError } from "../src/common/domain-error.js";
import { AdminPaymentJobsController } from "../src/modules/admin/admin-payment-jobs.controller.js";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PaymentFeedSources } from "../src/modules/payments/payment-feed-sources.js";
import { PaymentJobs, jobBelongsTo } from "../src/modules/payments/payment-jobs.js";
import type { PaymentRetry } from "../src/modules/payments/payment-retry.js";
import { PaymentJobNotFoundError, PurchaseActionUnavailableError } from "../src/modules/payments/payments-errors.js";
import { PaymentsHooks, type SupportAction } from "../src/modules/payments/payments-hooks.js";
import type { FailedPaymentJob, PaymentsQueue } from "../src/modules/payments/payments-queue.js";
import type { StoredPurchase } from "../src/modules/payments/purchase-types.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPurchasesRepository } from "./helpers/memory-purchases.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Брошенные задания очереди оплаты в панели (tasks/T-0431, Р209, WP53):
 * какое задание чьё, список, повтор одного задания и источник карточки
 * платежа. Очередь подменена — шпион с двумя вызовами; роли, аккаунты и
 * покупки — в памяти, реестр источников — настоящий.
 */

const NOW = new Date(Date.UTC(2026, 10, 12, 9, 30));
const OWNER_ID = "777000111";
const NOTE = "Игрок написал в поддержку: оплата не пришла";
const PURCHASE_ID = "11111111-1111-4111-8111-111111111111";
const CHARGE_ID = "charge-abc";

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

describe("jobBelongsTo: какое задание чьё", () => {
  const own = { purchaseId: PURCHASE_ID, telegramChargeId: CHARGE_ID };

  it("подтверждение — по id покупки из счёта", () => {
    expect(jobBelongsTo(failedJob({ kind: "confirm", purchaseId: PURCHASE_ID }), own)).toBe(true);
  });

  it("заказанный возврат — по покупке заказа", () => {
    expect(jobBelongsTo(failedJob({ kind: "refund", purchaseId: PURCHASE_ID }), own)).toBe(true);
  });

  it("внешний возврат — по номеру оплаты: покупки в нём нет", () => {
    expect(jobBelongsTo(failedJob({ kind: "refunded", purchaseId: null, chargeId: CHARGE_ID }), own)).toBe(true);
  });

  it("чужая покупка и чужая оплата — нет", () => {
    const stranger = { purchaseId: randomUUID(), telegramChargeId: "charge-other" };

    expect(jobBelongsTo(failedJob({ kind: "confirm" }), stranger)).toBe(false);
    expect(jobBelongsTo(failedJob({ kind: "refund" }), stranger)).toBe(false);
    expect(jobBelongsTo(failedJob({ kind: "refunded", purchaseId: null }), stranger)).toBe(false);
  });

  it("у подтверждения и заказанного возврата номер оплаты не в счёт: совпавший номер при другой покупке — нет", () => {
    const sameCharge = { purchaseId: randomUUID(), telegramChargeId: CHARGE_ID };

    expect(jobBelongsTo(failedJob({ kind: "confirm", chargeId: CHARGE_ID }), sameCharge)).toBe(false);
    expect(jobBelongsTo(failedJob({ kind: "refund", chargeId: CHARGE_ID }), sameCharge)).toBe(false);
  });

  it("покупка без номера оплаты не совпадает с внешним возвратом, даже если у задания номера нет", () => {
    const noCharge = { purchaseId: PURCHASE_ID, telegramChargeId: null };

    expect(jobBelongsTo(failedJob({ kind: "refunded", purchaseId: null, chargeId: CHARGE_ID }), noCharge)).toBe(false);
    expect(jobBelongsTo(failedJob({ kind: "refunded", purchaseId: null, chargeId: null }), noCharge)).toBe(false);
  });

  it("у задания нет покупки (битые данные, возврат «ничей») — не принадлежит никому", () => {
    expect(jobBelongsTo(failedJob({ kind: "confirm", purchaseId: null }), own)).toBe(false);
    expect(jobBelongsTo(failedJob({ kind: "refund", purchaseId: null }), own)).toBe(false);
    expect(jobBelongsTo(failedJob({ kind: "unknown", purchaseId: null, chargeId: null }), own)).toBe(false);
  });
});

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
  const sources = new PaymentFeedSources();

  /** Очередь-подмена: список брошенных (`null` — очереди нет) и ответы на повтор по идентификатору задания. */
  const queueState: { failed: FailedPaymentJob[] | null; asked: number[]; retried: string[]; answers: Map<string, "retried" | "not_found" | "not_failed"> } = {
    failed: [],
    asked: [],
    retried: [],
    answers: new Map(),
  };
  const queue = {
    failedJobs: async (limit: number) => {
      queueState.asked.push(limit);
      return queueState.failed;
    },
    retryFailed: async (jobId: string) => {
      queueState.retried.push(jobId);
      return queueState.answers.get(jobId) ?? "retried";
    },
  } as unknown as PaymentsQueue;

  const jobs = new PaymentJobs(cfg, queue, purchases, roles, accounts, hooks, sources);
  jobs.onModuleInit();
  return { cfg, accounts, rolesRepository, roles, purchases, hooks, events, sources, queueState, queue, jobs };
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

describe("PaymentJobs.list: список брошенных заданий", () => {
  let s: Setup;
  let admin: AccountRef;

  beforeEach(async () => {
    s = setup();
    admin = await person(s, "800001", "admin");
  });

  it("админ получает задания очереди — до 200, очередь отвечает, available: true", async () => {
    s.queueState.failed = [failedJob(), failedJob({ jobId: "refund-bbbb2222", kind: "refund", amount: null })];

    const result = await s.jobs.list(admin);

    expect(result).toEqual({ available: true, jobs: s.queueState.failed });
    expect(s.queueState.asked).toEqual([200]);
  });

  it("брошенных заданий нет — available: true и пустой список: это не «очереди нет»", async () => {
    expect(await s.jobs.list(admin)).toEqual({ available: true, jobs: [] });
  });

  it("очереди нет (Redis не отвечает или оплата выключена) — available: false и пустой список, не ошибка", async () => {
    s.queueState.failed = null;

    expect(await s.jobs.list(admin)).toEqual({ available: false, jobs: [] });
  });

  it.each([["moderator" as const], ["game_designer" as const]])("роль %s без payments.view — ForbiddenError, очередь не читается", async (role) => {
    const weak = await person(s, `8100${role.length}`, role);

    await expect(s.jobs.list(weak)).rejects.toBeInstanceOf(ForbiddenError);

    expect(s.queueState.asked).toEqual([]);
  });

  it("владелец (из списка окружения) читает список", async () => {
    const owner = await person(s, OWNER_ID);
    s.queueState.failed = [failedJob()];

    expect((await s.jobs.list(owner)).jobs).toHaveLength(1);
  });

  it("идентификатор плательщика на площадке — только с players.pii.view: без права он стёрт, остальное на месте", async () => {
    s.queueState.failed = [failedJob({ payerId: "555000111" })];
    vi.spyOn(s.roles, "can").mockImplementation(async (_actor, permission) => permission !== "players.pii.view");

    const { jobs } = await s.jobs.list(admin);

    expect(jobs).toEqual([failedJob({ payerId: null })]);
  });

  it("с правом players.pii.view идентификатор плательщика остаётся", async () => {
    s.queueState.failed = [failedJob({ payerId: "555000111" })];

    const { jobs } = await s.jobs.list(admin);

    expect(jobs[0]?.payerId).toBe("555000111");
  });
});

describe("PaymentJobs.retryJob: повтор одного задания", () => {
  let s: Setup;
  let admin: AccountRef;
  let target: AccountRef;

  beforeEach(async () => {
    s = setup();
    admin = await person(s, "820001", "admin", "Анна из поддержки");
    target = await person(s, "820002");
  });

  it("удача: задание повторено, в журнале payments.job.retry с причиной, поддержке — сообщение с деталью", async () => {
    put(s, purchase(target.accountId));
    s.queueState.failed = [failedJob()];

    const result = await s.jobs.retryJob(admin, "confirm-aaaa1111", NOTE, NOW);

    expect(result).toEqual({ jobId: "confirm-aaaa1111", purchaseId: PURCHASE_ID });
    expect(s.queueState.retried).toEqual(["confirm-aaaa1111"]);
    expect(s.rolesRepository.entries).toHaveLength(1);
    expect(s.rolesRepository.entries[0]).toMatchObject({
      actorAccountId: admin.accountId,
      action: "payments.job.retry",
      target: target.accountId,
      after: { jobId: "confirm-aaaa1111", kind: "confirm", chargeId: CHARGE_ID, purchaseId: PURCHASE_ID, note: NOTE },
    });
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({ kind: "retry", actorName: "Анна из поддержки", note: NOTE, at: NOW, detail: "повторено задание: подтверждение оплаты" });
    expect(s.events[0]?.purchase).toMatchObject({ purchaseId: PURCHASE_ID });
    expect(logged).toContainEqual({
      level: "log",
      event: "payment_job_retried",
      fields: expect.objectContaining({ module: "payments", jobId: "confirm-aaaa1111", kind: "confirm", purchaseId: PURCHASE_ID, actorAccountId: admin.accountId }) as Record<string, unknown>,
    });
  });

  it.each([
    ["confirm", "подтверждение оплаты"],
    ["refund", "возврат"],
  ] as const)("деталь сообщения для задания вида %s — «повторено задание: %s»", async (kind, label) => {
    put(s, purchase(target.accountId));
    s.queueState.failed = [failedJob({ kind })];

    await s.jobs.retryJob(admin, "confirm-aaaa1111", NOTE, NOW);

    expect(s.events[0]?.detail).toBe(`повторено задание: ${label}`);
  });

  it("внешний возврат: покупки в задании нет — журнал с target null, а сообщения команде нет", async () => {
    s.queueState.failed = [failedJob({ jobId: "refunded-cccc3333", kind: "refunded", purchaseId: null, payerId: null, amount: null })];

    const result = await s.jobs.retryJob(admin, "refunded-cccc3333", NOTE, NOW);

    expect(result).toEqual({ jobId: "refunded-cccc3333", purchaseId: null });
    expect(s.rolesRepository.entries).toHaveLength(1);
    expect(s.rolesRepository.entries[0]).toMatchObject({
      action: "payments.job.retry",
      target: null,
      after: { jobId: "refunded-cccc3333", kind: "refunded", chargeId: CHARGE_ID, purchaseId: null, note: NOTE },
    });
    expect(s.events).toEqual([]);
  });

  it("задания, о котором спрашивают, нет среди брошенных — 404 с текстом про последние 1000", async () => {
    s.queueState.failed = [failedJob({ jobId: "confirm-other0000" })];

    const attempt = s.jobs.retryJob(admin, "confirm-aaaa1111", NOTE, NOW);

    await expect(attempt).rejects.toBeInstanceOf(PaymentJobNotFoundError);
    await expect(attempt).rejects.toMatchObject({ code: "payment_job_not_found", status: 404, message: "Задание не найдено: очередь хранит последние 1000 брошенных" });
    expect(s.queueState.retried).toEqual([]);
    expect(s.rolesRepository.entries).toEqual([]);
    expect(s.events).toEqual([]);
  });

  it("очередь ответила not_found — задание убрали между списком и повтором: тот же 404, журнала нет", async () => {
    put(s, purchase(target.accountId));
    s.queueState.failed = [failedJob()];
    s.queueState.answers.set("confirm-aaaa1111", "not_found");

    await expect(s.jobs.retryJob(admin, "confirm-aaaa1111", NOTE, NOW)).rejects.toMatchObject({ code: "payment_job_not_found", status: 404 });

    expect(s.rolesRepository.entries).toEqual([]);
    expect(s.events).toEqual([]);
  });

  it("очередь ответила not_failed — задание уже повторили: 409, журнала и сообщения нет", async () => {
    put(s, purchase(target.accountId));
    s.queueState.failed = [failedJob()];
    s.queueState.answers.set("confirm-aaaa1111", "not_failed");

    const attempt = s.jobs.retryJob(admin, "confirm-aaaa1111", NOTE, NOW);

    await expect(attempt).rejects.toBeInstanceOf(PurchaseActionUnavailableError);
    await expect(attempt).rejects.toMatchObject({ code: "purchase_action_unavailable", status: 409, message: "Задание уже не брошено: его повторили или оно выполнилось" });
    expect(s.rolesRepository.entries).toEqual([]);
    expect(s.events).toEqual([]);
  });

  it("очереди нет — 409 с причиной, повтор не пробуется", async () => {
    s.queueState.failed = null;

    const attempt = s.jobs.retryJob(admin, "confirm-aaaa1111", NOTE, NOW);

    await expect(attempt).rejects.toBeInstanceOf(PurchaseActionUnavailableError);
    await expect(attempt).rejects.toMatchObject({ message: "Очередь оплаты недоступна: Redis не отвечает или оплата выключена" });
    expect(s.queueState.retried).toEqual([]);
  });

  it("задание своей покупки — ForbiddenError, повтор не пробуется", async () => {
    put(s, purchase(admin.accountId));
    s.queueState.failed = [failedJob()];

    const attempt = s.jobs.retryJob(admin, "confirm-aaaa1111", NOTE, NOW);

    await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
    await expect(attempt).rejects.toMatchObject({ message: "Повторять учёт своей покупки нельзя" });
    expect(s.queueState.retried).toEqual([]);
    expect(s.rolesRepository.entries).toEqual([]);
  });

  it("со входом разработчика задание своей покупки повторяется: проверить на себе", async () => {
    const dev = setup({ NODE_ENV: "development", AUTH_DEV_LOGIN: "true" });
    const me = await person(dev, "820010", "admin");
    put(dev, purchase(me.accountId));
    dev.queueState.failed = [failedJob()];

    await dev.jobs.retryJob(me, "confirm-aaaa1111", NOTE, NOW);

    expect(dev.queueState.retried).toEqual(["confirm-aaaa1111"]);
  });

  it("покупки из задания нет в базе — задание всё равно повторяется, но журнал без аккаунта и без сообщения", async () => {
    s.queueState.failed = [failedJob()];

    const result = await s.jobs.retryJob(admin, "confirm-aaaa1111", NOTE, NOW);

    expect(result.purchaseId).toBe(PURCHASE_ID);
    expect(s.rolesRepository.entries[0]).toMatchObject({ action: "payments.job.retry", target: null });
    expect(s.events).toEqual([]);
  });

  it.each([["moderator" as const], ["game_designer" as const]])("роль %s без payments.support — ForbiddenError, очередь не читается", async (role) => {
    const weak = await person(s, `8300${role.length}`, role);
    s.queueState.failed = [failedJob()];

    await expect(s.jobs.retryJob(weak, "confirm-aaaa1111", NOTE, NOW)).rejects.toBeInstanceOf(ForbiddenError);

    expect(s.queueState.asked).toEqual([]);
    expect(s.queueState.retried).toEqual([]);
  });

  it("имени актёра нет в аккаунтах — в сообщении команде стоит его id", async () => {
    put(s, purchase(target.accountId));
    s.queueState.failed = [failedJob()];
    const stranger: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: OWNER_ID };

    await s.jobs.retryJob(stranger, "confirm-aaaa1111", NOTE, NOW);

    expect(s.events[0]?.actorName).toBe(stranger.accountId);
  });
});

describe("PaymentJobs: источник карточки платежа", () => {
  let s: Setup;
  let target: AccountRef;
  const OTHER_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(async () => {
    s = setup();
    target = await person(s, "840001");
  });

  it("хронология: брошенное задание покупки — строка job_abandoned во время сбоя; чужие задания не попадают", async () => {
    const mine = put(s, purchase(target.accountId));
    const failedAt = new Date(NOW.getTime() - 600_000);
    s.queueState.failed = [failedJob({ failedAt, reason: "Connection terminated" }), failedJob({ jobId: "confirm-other0000", purchaseId: OTHER_ID, chargeId: "charge-other" })];

    const lines = await s.sources.timeline(mine);

    expect(lines).toEqual([{ at: failedAt, kind: "job_abandoned", text: "Задание оплаты брошено: подтверждение оплаты — Connection terminated", actorName: null }]);
    expect(s.queueState.asked).toEqual([1000]);
  });

  it("у каждого вида задания своя подпись; внешний возврат находится по номеру оплаты", async () => {
    const mine = put(s, purchase(target.accountId));
    s.queueState.failed = [
      failedJob({ jobId: "confirm-aaaa1111", kind: "confirm", reason: "а" }),
      failedJob({ jobId: "refund-bbbb2222", kind: "refund", reason: "б" }),
      failedJob({ jobId: "refunded-cccc3333", kind: "refunded", purchaseId: null, reason: "в" }),
    ];

    const lines = await s.sources.timeline(mine);

    expect(lines.map((line) => line.text)).toEqual(["Задание оплаты брошено: подтверждение оплаты — а", "Задание оплаты брошено: возврат — б", "Задание оплаты брошено: внешний возврат — в"]);
  });

  it("задание без времени сбоя в хронологию не попадает: строке некуда встать", async () => {
    const mine = put(s, purchase(target.accountId));
    s.queueState.failed = [failedJob({ failedAt: null })];

    expect(await s.sources.timeline(mine)).toEqual([]);
  });

  it("строка не длиннее 200 знаков, даже если причина на все 200", async () => {
    const mine = put(s, purchase(target.accountId));
    s.queueState.failed = [failedJob({ reason: "ж".repeat(200) })];

    const [line] = await s.sources.timeline(mine);

    expect([...(line?.text ?? "")].length).toBeLessThanOrEqual(200);
    expect(line?.text.startsWith("Задание оплаты брошено: подтверждение оплаты — ж")).toBe(true);
  });

  it("пометки ленты: job_abandoned только у покупок с брошенным заданием", async () => {
    const withJob = put(s, purchase(target.accountId));
    const clean = put(s, purchase(target.accountId, { purchaseId: OTHER_ID, telegramChargeId: "charge-clean" }));
    s.queueState.failed = [failedJob()];

    const marks = await s.sources.marks([withJob.purchaseId, clean.purchaseId]);

    expect(marks.get(withJob.purchaseId)).toEqual(["job_abandoned"]);
    expect(marks.has(clean.purchaseId)).toBe(false);
    expect(s.queueState.asked).toEqual([1000]);
  });

  it("пометка по внешнему возврату: покупка находится по номеру оплаты, лишних чтений базы нет у тех, кого нашли по заданию", async () => {
    const byCharge = put(s, purchase(target.accountId));
    const byJob = put(s, purchase(target.accountId, { purchaseId: OTHER_ID, telegramChargeId: "charge-second" }));
    s.queueState.failed = [
      failedJob({ jobId: "refunded-cccc3333", kind: "refunded", purchaseId: null, chargeId: CHARGE_ID }),
      failedJob({ jobId: "confirm-dddd4444", kind: "confirm", purchaseId: OTHER_ID, chargeId: "charge-second" }),
    ];
    const byId = vi.spyOn(s.purchases, "byId");

    const marks = await s.sources.marks([byCharge.purchaseId, byJob.purchaseId]);

    expect(marks.get(byCharge.purchaseId)).toEqual(["job_abandoned"]);
    expect(marks.get(byJob.purchaseId)).toEqual(["job_abandoned"]);
    expect(byId.mock.calls.map(([id]) => id)).toEqual([byCharge.purchaseId]);
  });

  it("нет брошенных заданий — пометок нет и в базу покупок не ходим", async () => {
    const mine = put(s, purchase(target.accountId));
    const byId = vi.spyOn(s.purchases, "byId");

    const marks = await s.sources.marks([mine.purchaseId]);

    expect(marks.size).toBe(0);
    expect(byId).not.toHaveBeenCalled();
  });

  it("действия: retry у покупки с брошенным заданием и пусто у остальных", async () => {
    const withJob = put(s, purchase(target.accountId));
    const clean = put(s, purchase(target.accountId, { purchaseId: OTHER_ID, telegramChargeId: "charge-clean" }));
    s.queueState.failed = [failedJob()];

    expect(await s.sources.actions(withJob)).toEqual(["retry"]);
    expect(await s.sources.actions(clean)).toEqual([]);
  });

  it("очереди нет — источник молчит: ни строк, ни пометок, ни действий", async () => {
    const mine = put(s, purchase(target.accountId));
    s.queueState.failed = null;

    expect(await s.sources.timeline(mine)).toEqual([]);
    expect((await s.sources.marks([mine.purchaseId])).size).toBe(0);
    expect(await s.sources.actions(mine)).toEqual([]);
  });

  it("перерегистрация на старте не удваивает строки: источник один", async () => {
    const mine = put(s, purchase(target.accountId));
    s.queueState.failed = [failedJob()];

    s.jobs.onModuleInit();

    expect(await s.sources.timeline(mine)).toHaveLength(1);
  });
});

describe("AdminPaymentJobsController: маршруты", () => {
  const ACTOR: AccountRef = { accountId: "33333333-3333-4333-8333-333333333333", platform: "telegram", platformUserId: "1" };
  const request = { account: ACTOR };

  function controller(allowed = true) {
    const calls: { method: string; args: unknown[] }[] = [];
    const jobs = {
      list: async (...args: unknown[]) => {
        calls.push({ method: "list", args });
        return { available: true, jobs: [failedJob()] };
      },
      retryJob: async (...args: unknown[]) => {
        calls.push({ method: "retryJob", args });
        return { jobId: "confirm-aaaa1111", purchaseId: PURCHASE_ID };
      },
    } as unknown as PaymentJobs;
    const retry = {
      retry: async (...args: unknown[]) => {
        calls.push({ method: "retry", args });
        return { retried: ["confirm-aaaa1111"] };
      },
    } as unknown as PaymentRetry;
    const limited: string[] = [];
    const limiter = {
      consume: async (_limit: unknown, key: string) => {
        limited.push(key);
        return allowed;
      },
    } as unknown as RateLimiter;
    return { routes: new AdminPaymentJobsController(jobs, retry, limiter), calls, limited };
  }

  it("пути: payment-jobs отдельно от payments, чтобы GET payments/:purchaseId не перехватил список", () => {
    expect(Reflect.getMetadata("path", AdminPaymentJobsController)).toBe("admin");
    expect(Reflect.getMetadata("path", AdminPaymentJobsController.prototype.list)).toBe("payment-jobs");
    expect(Reflect.getMetadata("path", AdminPaymentJobsController.prototype.retryJob)).toBe("payment-jobs/:jobId/retry");
    expect(Reflect.getMetadata("path", AdminPaymentJobsController.prototype.retryPayment)).toBe("payments/:purchaseId/retry");
  });

  it("список — под payments.view, оба повтора — под payments.support", () => {
    expect(Reflect.getMetadata(PERMISSION_METADATA, AdminPaymentJobsController.prototype.list)).toBe("payments.view");
    expect(Reflect.getMetadata(PERMISSION_METADATA, AdminPaymentJobsController.prototype.retryJob)).toBe("payments.support");
    expect(Reflect.getMetadata(PERMISSION_METADATA, AdminPaymentJobsController.prototype.retryPayment)).toBe("payments.support");
  });

  it("список: ответ в { data }, актёр доходит до сервиса", async () => {
    const { routes, calls } = controller();

    const response = await routes.list(request);

    expect(response).toEqual({ data: { available: true, jobs: [failedJob()] } });
    expect(calls).toEqual([{ method: "list", args: [ACTOR] }]);
  });

  it("повтор задания: актёр, идентификатор и причина доходят до сервиса, ответ в { data }", async () => {
    const { routes, calls, limited } = controller();

    const response = await routes.retryJob(request, "confirm-aaaa1111", { note: `  ${NOTE}  ` });

    expect(response).toEqual({ data: { jobId: "confirm-aaaa1111", purchaseId: PURCHASE_ID } });
    expect(calls).toEqual([{ method: "retryJob", args: [ACTOR, "confirm-aaaa1111", NOTE] }]);
    expect(limited).toEqual([ACTOR.accountId]);
  });

  it.each([["ab"], ["CONFIRM-AAAA"], ["confirm_aaaa"], ["с кириллицей"], ["a".repeat(121)], ["a/b"]])("повтор задания: идентификатор %j — 400 «Некорректный идентификатор задания»", async (jobId) => {
    const { routes, calls } = controller();

    const failure = await routes.retryJob(request, jobId, { note: NOTE }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ValidationError);
    expect((failure as ValidationError).message).toBe("Некорректный идентификатор задания");
    expect(calls).toEqual([]);
  });

  it("повтор задания: идентификатор настоящего задания (refunded-<отпечаток>) проходит", async () => {
    const { routes } = controller();

    await expect(routes.retryJob(request, `refunded-${"a1".repeat(16)}`, { note: NOTE })).resolves.toBeDefined();
  });

  it.each([[{}], [{ note: "ab" }], [{ note: "   " }], [{ note: "я".repeat(201) }], [{ note: 5 }], [null]])("повтор: тело %j — 400 «Укажите причину: от 3 до 200 символов»", async (body) => {
    const { routes, calls } = controller();

    const first = await routes.retryJob(request, "confirm-aaaa1111", body).catch((error: unknown) => error);
    const second = await routes.retryPayment(request, PURCHASE_ID, body).catch((error: unknown) => error);

    for (const failure of [first, second]) {
      expect(failure).toBeInstanceOf(ValidationError);
      expect((failure as ValidationError).message).toBe("Укажите причину: от 3 до 200 символов");
    }
    expect(calls).toEqual([]);
  });

  it("повтор учёта: идентификатор покупки — UUID, иначе 400; ответ — в { data }", async () => {
    const { routes, calls } = controller();

    const response = await routes.retryPayment(request, PURCHASE_ID, { note: NOTE });
    const failure = await routes.retryPayment(request, "не-uuid", { note: NOTE }).catch((error: unknown) => error);

    expect(response).toEqual({ data: { retried: ["confirm-aaaa1111"] } });
    expect(calls).toEqual([{ method: "retry", args: [ACTOR, PURCHASE_ID, NOTE] }]);
    expect(failure).toBeInstanceOf(ValidationError);
    expect((failure as ValidationError).message).toBe("Некорректный идентификатор покупки");
  });

  it("слишком частые действия — 429, сервис не зовётся", async () => {
    const { routes, calls } = controller(false);

    await expect(routes.retryJob(request, "confirm-aaaa1111", { note: NOTE })).rejects.toBeInstanceOf(RateLimitedError);
    await expect(routes.retryPayment(request, PURCHASE_ID, { note: NOTE })).rejects.toBeInstanceOf(RateLimitedError);

    expect(calls).toEqual([]);
  });
});
