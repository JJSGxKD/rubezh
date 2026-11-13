import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "../src/common/domain-error.js";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { PaymentDiscrepancies } from "../src/modules/payments/payment-discrepancies.js";
import { PaymentFeedSources } from "../src/modules/payments/payment-feed-sources.js";
import type { DiscrepancyResolution } from "../src/modules/payments/payment-reconcile.js";
import type { DiscrepancyRow, PaymentDiscrepancyStore } from "../src/modules/payments/payment-reconcile.repository.js";
import { DiscrepancyNotFoundError, PurchaseActionUnavailableError } from "../src/modules/payments/payments-errors.js";
import { PaymentsHooks, type SupportAction } from "../src/modules/payments/payments-hooks.js";
import type { PaymentsQueue } from "../src/modules/payments/payments-queue.js";
import type { StoredPurchase } from "../src/modules/payments/purchase-types.js";
import type { RefundOrder } from "../src/modules/payments/purchases.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { PaymentProviders } from "../src/platforms/ports/payment-provider.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { starsProviders } from "./helpers/fake-stars-api.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPurchasesRepository } from "./helpers/memory-purchases.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Действия по расхождениям сверки (tasks/T-0434, Р209, WP53): «Повторить
 * учёт», «Вернуть звёзды», «Разобрано» и источник хронологии платежа.
 * Хранилище расхождений, очередь и площадка подставные, роли, аккаунты и
 * покупки — в памяти. Закрепляется то, где такие действия ломаются: гонка
 * двух нажатий, недоступное по виду действие, своя оплата, право.
 */

const NOW = new Date(Date.UTC(2026, 10, 13, 10, 0));
const OCCURRED_AT = new Date(Date.UTC(2026, 10, 13, 6, 30));
const DETECTED_AT = new Date(Date.UTC(2026, 10, 13, 7, 0));
const OWNER_ID = "777000111";
const NOTE = "Игрок прислал скриншот оплаты, в базе её нет";
const PURCHASE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PURCHASE_ID = "22222222-2222-4222-8222-222222222222";
const CHARGE_ID = "stx-0123456789abcdef";
const PAYER_ID = "555000111";

const ALREADY_RESOLVED = "Расхождение уже разобрано";
const NOT_RETRYABLE = "Повторять нечего: оплаты нет в выписке площадки. Не появится — нажмите «Разобрано» с причиной";
const NOT_REFUNDABLE = "Вернуть звёзды можно только у оплаты, которую мы не записали; у записанной — кнопкой в карточке платежа";
const NO_PAYER = "В выписке нет игрока — вернуть или записать оплату нельзя";

function config(env: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID, ...env } as NodeJS.ProcessEnv);
}

function row(accountId: string | null, patch: Partial<DiscrepancyRow> = {}): DiscrepancyRow {
  return {
    discrepancyId: randomUUID(),
    platform: "telegram",
    kind: "charged_unrecorded",
    chargeId: CHARGE_ID,
    purchaseId: PURCHASE_ID,
    accountId,
    payerId: PAYER_ID,
    amount: 75,
    payload: PURCHASE_ID,
    occurredAt: OCCURRED_AT,
    detectedAt: DETECTED_AT,
    resolution: null,
    resolvedAt: null,
    resolvedBy: null,
    note: null,
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
    priceStars: 75,
    chargedStars: 75,
    mode: "live",
    status: "pending",
    telegramChargeId: null,
    invoicedAt: new Date(OCCURRED_AT.getTime() - 120_000),
    paidAt: null,
    refundReason: null,
    refundRequestedAt: null,
    refundedAt: null,
    fulfilledAt: null,
    renewalOf: null,
    ...patch,
  };
}

/**
 * Хранилище расхождений в памяти. `claim` — как условный `updateMany … where resolved_at is null`: занять можно
 * только открытое. `barrier` — сколько чтений `byId` ждать вместе: так два нажатия читают расхождение открытым
 * до того, как любое из них успело его занять, и гонка воспроизводится без случайности.
 */
class MemoryStore implements PaymentDiscrepancyStore {
  rows: DiscrepancyRow[] = [];
  readonly claims: { discrepancyId: string; resolution: DiscrepancyResolution; actorAccountId: string; note: string; at: Date }[] = [];
  readonly byIdCalls: string[] = [];
  readonly openByPurchasesCalls: string[][] = [];
  barrier: number | null = null;
  private waiting: (() => void)[] = [];

  constructor(private readonly trace: string[]) {}

  async byId(discrepancyId: string): Promise<DiscrepancyRow | null> {
    this.byIdCalls.push(discrepancyId);
    const found = this.rows.find((candidate) => candidate.discrepancyId === discrepancyId);
    const snapshot = found === undefined ? null : { ...found };
    if (this.barrier !== null) {
      const need = this.barrier;
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
        if (this.waiting.length >= need) for (const release of this.waiting.splice(0)) release();
      });
    }
    return snapshot;
  }

  async byPurchase(purchaseId: string): Promise<DiscrepancyRow[]> {
    return this.rows.filter((candidate) => candidate.purchaseId === purchaseId).sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime());
  }

  async openByPurchases(purchaseIds: readonly string[]): Promise<DiscrepancyRow[]> {
    this.openByPurchasesCalls.push([...purchaseIds]);
    return this.rows.filter((candidate) => candidate.resolvedAt === null && candidate.purchaseId !== null && purchaseIds.includes(candidate.purchaseId));
  }

  async claim(discrepancyId: string, resolution: DiscrepancyResolution, actorAccountId: string, note: string, at: Date): Promise<boolean> {
    this.claims.push({ discrepancyId, resolution, actorAccountId, note, at });
    const found = this.rows.find((candidate) => candidate.discrepancyId === discrepancyId);
    if (found === undefined || found.resolvedAt !== null) return false;
    Object.assign(found, { resolution, resolvedBy: actorAccountId, note, resolvedAt: at });
    this.trace.push("claim");
    return true;
  }
}

type ReplayJob = Parameters<PaymentsQueue["replay"]>[0];

function setup(env: Record<string, string> = {}, providers: PaymentProviders = starsProviders()) {
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
  /** порядок событий: занять расхождение обязано раньше постановки задания */
  const trace: string[] = [];
  const store = new MemoryStore(trace);
  const replayed: { job: ReplayJob; tag: string }[] = [];
  const dispatched: RefundOrder[][] = [];
  const queue = {
    replay: async (job: ReplayJob, tag: string) => {
      trace.push("replay");
      replayed.push({ job, tag });
    },
    dispatchRefunds: async (orders: Promise<RefundOrder[]>) => {
      trace.push("refund");
      dispatched.push(await orders);
    },
  } as unknown as PaymentsQueue;
  const sources = new PaymentFeedSources();
  const service = new PaymentDiscrepancies(cfg, store, queue, providers, purchases, roles, accounts, hooks, sources);
  service.onModuleInit();
  return { cfg, accounts, rolesRepository, roles, purchases, hooks, events, store, trace, replayed, dispatched, queue, sources, service };
}

type Setup = ReturnType<typeof setup>;

async function person(s: Setup, id: string, role?: "admin" | "moderator" | "game_designer", displayName = `Игрок ${id}`): Promise<AccountRef> {
  const account = await s.accounts.upsert({ platform: "telegram", platformUserId: id, displayName, username: null, photoUrl: null }, NOW.getTime());
  if (role !== undefined) await s.rolesRepository.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}

describe("PaymentDiscrepancies: действия по расхождениям", () => {
  let s: Setup;
  let admin: AccountRef;
  let target: AccountRef;
  let logged: { level: string; event: string; fields: Record<string, unknown> }[];

  /** Расхождение игрока `target` лежит в хранилище, а его покупка — в базе покупок. */
  function open(patch: Partial<DiscrepancyRow> = {}, withPurchase = true): DiscrepancyRow {
    const discrepancy = row(target.accountId, patch);
    s.store.rows.push(discrepancy);
    if (withPurchase && discrepancy.purchaseId !== null) s.purchases.rows.set(discrepancy.purchaseId, purchase(target.accountId, { purchaseId: discrepancy.purchaseId }));
    return discrepancy;
  }

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
    target = await person(s, "900002", undefined, "Стрелок");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("«Повторить учёт»", () => {
    it("«списано, но не записано»: задание подтверждения по выписке — со временем операции площадки, суммой, счётом и валютой площадки", async () => {
      const discrepancy = open();

      const view = await s.service.retry(admin, discrepancy.discrepancyId, NOTE, NOW);

      expect(s.replayed).toEqual([
        {
          job: { kind: "confirm", payment: { platform: "telegram", chargeId: CHARGE_ID, payload: PURCHASE_ID, payerId: PAYER_ID, currency: "XTR", totalAmount: 75 }, at: OCCURRED_AT.getTime() },
          tag: "reconcile",
        },
      ]);
      expect(view).toMatchObject({
        discrepancyId: discrepancy.discrepancyId,
        kind: "charged_unrecorded",
        resolution: "retried",
        resolvedAt: NOW,
        resolvedByName: "Анна из поддержки",
        displayName: "Стрелок",
        note: NOTE,
        payerId: PAYER_ID,
      });
    });

    it("сначала расхождение занимается, потом ставится задание: двойному нажатию задания не достанется", async () => {
      const discrepancy = open();

      await s.service.retry(admin, discrepancy.discrepancyId, NOTE, NOW);

      expect(s.trace).toEqual(["claim", "replay"]);
      expect(s.store.claims).toEqual([{ discrepancyId: discrepancy.discrepancyId, resolution: "retried", actorAccountId: admin.accountId, note: NOTE, at: NOW }]);
    });

    it("журнал payments.discrepancy.retry: аккаунт расхождения, вид, оплата, покупка и причина", async () => {
      const discrepancy = open();

      await s.service.retry(admin, discrepancy.discrepancyId, NOTE, NOW);

      expect(s.rolesRepository.entries).toHaveLength(1);
      expect(s.rolesRepository.entries[0]).toMatchObject({
        actorAccountId: admin.accountId,
        action: "payments.discrepancy.retry",
        target: target.accountId,
        after: { discrepancyId: discrepancy.discrepancyId, kind: "charged_unrecorded", chargeId: CHARGE_ID, purchaseId: PURCHASE_ID, note: NOTE },
      });
    });

    it("покупка найдена — сообщение команде: повтор, «запись по выписке площадки»", async () => {
      const discrepancy = open();

      await s.service.retry(admin, discrepancy.discrepancyId, NOTE, NOW);

      expect(s.events).toHaveLength(1);
      expect(s.events[0]).toMatchObject({ kind: "retry", actorName: "Анна из поддержки", note: NOTE, at: NOW, detail: "запись по выписке площадки" });
      expect(s.events[0]?.purchase).toMatchObject({ purchaseId: PURCHASE_ID, accountId: target.accountId });
    });

    it("в лог — discrepancy_resolved: расхождение, вид и чем закрыто", async () => {
      const discrepancy = open();

      await s.service.retry(admin, discrepancy.discrepancyId, NOTE, NOW);

      expect(logged).toContainEqual({
        level: "log",
        event: "discrepancy_resolved",
        fields: expect.objectContaining({ module: "payments", discrepancyId: discrepancy.discrepancyId, kind: "charged_unrecorded", resolution: "retried" }) as Record<string, unknown>,
      });
    });

    it("счёта в выписке не было — в задании пустой payload: неизвестный счёт вернёт звёзды сам (unmatched)", async () => {
      const discrepancy = open({ payload: null, purchaseId: null, accountId: null }, false);

      await s.service.retry(admin, discrepancy.discrepancyId, NOTE, NOW);

      expect(s.replayed[0]?.job).toMatchObject({ kind: "confirm", payment: { payload: "" } });
      expect(s.events).toEqual([]);
      expect(s.rolesRepository.entries[0]).toMatchObject({ target: null, after: { purchaseId: null } });
    });

    it("«возврат в Telegram, но не у нас»: задание возврата по выписке — с оплатой и временем операции; игрок в выписке не нужен", async () => {
      const discrepancy = open({ kind: "refund_unrecorded", payerId: null });

      const view = await s.service.retry(admin, discrepancy.discrepancyId, NOTE, NOW);

      expect(s.replayed).toEqual([{ job: { kind: "refunded", chargeId: CHARGE_ID, at: OCCURRED_AT.getTime() }, tag: "reconcile" }]);
      expect(view).toMatchObject({ kind: "refund_unrecorded", resolution: "retried" });
      expect(s.events[0]).toMatchObject({ kind: "retry", detail: "запись по выписке площадки" });
    });

    it("«записано, но нет в выписке»: повторять нечего — 409 с текстом, что делать; занятия, задания и журнала нет", async () => {
      const discrepancy = open({ kind: "recorded_missing", payerId: null });

      const attempt = s.service.retry(admin, discrepancy.discrepancyId, NOTE, NOW);

      await expect(attempt).rejects.toBeInstanceOf(PurchaseActionUnavailableError);
      await expect(attempt).rejects.toMatchObject({ code: "purchase_action_unavailable", status: 409, message: NOT_RETRYABLE });
      expect(s.store.claims).toEqual([]);
      expect(s.replayed).toEqual([]);
      expect(s.rolesRepository.entries).toEqual([]);
      expect(s.events).toEqual([]);
      expect(s.store.rows[0]?.resolvedAt).toBeNull();
    });

    it("в выписке нет игрока — 409: оплату без него не записать", async () => {
      const discrepancy = open({ payerId: null });

      await expect(s.service.retry(admin, discrepancy.discrepancyId, NOTE, NOW)).rejects.toMatchObject({ status: 409, message: NO_PAYER });

      expect(s.store.claims).toEqual([]);
      expect(s.replayed).toEqual([]);
    });

    it("у площадки расхождения нет способа оплаты — 409, расхождение остаётся открытым", async () => {
      const bare = setup({}, new PaymentProviders([]));
      const player = await person(bare, "900003");
      const operator = await person(bare, "900004", "admin");
      const discrepancy = row(player.accountId);
      bare.store.rows.push(discrepancy);

      await expect(bare.service.retry(operator, discrepancy.discrepancyId, NOTE, NOW)).rejects.toMatchObject({ status: 409, message: "Площадка не принимает оплату — записать или вернуть её нельзя" });

      expect(bare.store.claims).toEqual([]);
      expect(bare.replayed).toEqual([]);
    });
  });

  describe("«Вернуть звёзды»", () => {
    it("«списано, но не записано»: заказ возврата без покупки, причина manual; задания записи нет", async () => {
      const discrepancy = open();

      const view = await s.service.refund(admin, discrepancy.discrepancyId, NOTE, NOW);

      expect(s.dispatched).toEqual([[{ purchaseId: null, platform: "telegram", chargeId: CHARGE_ID, payerId: PAYER_ID, reason: "manual" }]]);
      expect(s.replayed).toEqual([]);
      expect(s.trace).toEqual(["claim", "refund"]);
      expect(view).toMatchObject({ kind: "charged_unrecorded", resolution: "refunded", resolvedAt: NOW, resolvedByName: "Анна из поддержки", note: NOTE });
    });

    it("журнал payments.discrepancy.refund и сообщение команде: возврат, «оплата не была записана — возврат по выписке»", async () => {
      const discrepancy = open();

      await s.service.refund(admin, discrepancy.discrepancyId, NOTE, NOW);

      expect(s.rolesRepository.entries).toHaveLength(1);
      expect(s.rolesRepository.entries[0]).toMatchObject({
        actorAccountId: admin.accountId,
        action: "payments.discrepancy.refund",
        target: target.accountId,
        after: { discrepancyId: discrepancy.discrepancyId, kind: "charged_unrecorded", chargeId: CHARGE_ID, purchaseId: PURCHASE_ID, note: NOTE },
      });
      expect(s.events).toHaveLength(1);
      expect(s.events[0]).toMatchObject({ kind: "refund", actorName: "Анна из поддержки", note: NOTE, at: NOW, detail: "оплата не была записана — возврат по выписке" });
      expect(logged).toContainEqual({
        level: "log",
        event: "discrepancy_resolved",
        fields: expect.objectContaining({ discrepancyId: discrepancy.discrepancyId, kind: "charged_unrecorded", resolution: "refunded" }) as Record<string, unknown>,
      });
    });

    it("покупки нет — возврат уходит, сообщения команде нет", async () => {
      const discrepancy = open({ purchaseId: null, accountId: null, payload: null }, false);

      await s.service.refund(admin, discrepancy.discrepancyId, NOTE, NOW);

      expect(s.dispatched).toHaveLength(1);
      expect(s.events).toEqual([]);
    });

    it.each([["refund_unrecorded"], ["recorded_missing"]])("у вида %s возврата нет — 409: у записанной оплаты звёзды возвращают в карточке платежа", async (kind) => {
      const discrepancy = open({ kind });

      const attempt = s.service.refund(admin, discrepancy.discrepancyId, NOTE, NOW);

      await expect(attempt).rejects.toBeInstanceOf(PurchaseActionUnavailableError);
      await expect(attempt).rejects.toMatchObject({ status: 409, message: NOT_REFUNDABLE });
      expect(s.store.claims).toEqual([]);
      expect(s.dispatched).toEqual([]);
      expect(s.rolesRepository.entries).toEqual([]);
    });

    it("в выписке нет игрока — 409: некому вернуть", async () => {
      const discrepancy = open({ payerId: null });

      await expect(s.service.refund(admin, discrepancy.discrepancyId, NOTE, NOW)).rejects.toMatchObject({ status: 409, message: NO_PAYER });

      expect(s.store.claims).toEqual([]);
      expect(s.dispatched).toEqual([]);
    });
  });

  describe("«Разобрано»", () => {
    it("решение dismissed с причиной: ни задания, ни возврата, ни сообщения команде", async () => {
      const discrepancy = open();

      const view = await s.service.dismiss(admin, discrepancy.discrepancyId, NOTE, NOW);

      expect(view).toMatchObject({ discrepancyId: discrepancy.discrepancyId, resolution: "dismissed", resolvedAt: NOW, resolvedByName: "Анна из поддержки", note: NOTE });
      expect(s.store.claims).toEqual([{ discrepancyId: discrepancy.discrepancyId, resolution: "dismissed", actorAccountId: admin.accountId, note: NOTE, at: NOW }]);
      expect(s.replayed).toEqual([]);
      expect(s.dispatched).toEqual([]);
      expect(s.events).toEqual([]);
    });

    it("журнал payments.discrepancy.dismiss и строка discrepancy_resolved", async () => {
      const discrepancy = open();

      await s.service.dismiss(admin, discrepancy.discrepancyId, NOTE, NOW);

      expect(s.rolesRepository.entries).toHaveLength(1);
      expect(s.rolesRepository.entries[0]).toMatchObject({
        action: "payments.discrepancy.dismiss",
        target: target.accountId,
        after: { discrepancyId: discrepancy.discrepancyId, kind: "charged_unrecorded", chargeId: CHARGE_ID, purchaseId: PURCHASE_ID, note: NOTE },
      });
      expect(logged).toContainEqual({
        level: "log",
        event: "discrepancy_resolved",
        fields: expect.objectContaining({ discrepancyId: discrepancy.discrepancyId, resolution: "dismissed" }) as Record<string, unknown>,
      });
    });

    it.each([["charged_unrecorded"], ["recorded_missing"], ["refund_unrecorded"]])("доступно у каждого вида — %s, даже без игрока в выписке", async (kind) => {
      const discrepancy = open({ kind, payerId: null });

      const view = await s.service.dismiss(admin, discrepancy.discrepancyId, NOTE, NOW);

      expect(view.resolution).toBe("dismissed");
    });
  });

  describe("общие правила", () => {
    const actions = [
      ["retry", (service: PaymentDiscrepancies, actor: AccountRef, id: string) => service.retry(actor, id, NOTE, NOW)],
      ["refund", (service: PaymentDiscrepancies, actor: AccountRef, id: string) => service.refund(actor, id, NOTE, NOW)],
      ["dismiss", (service: PaymentDiscrepancies, actor: AccountRef, id: string) => service.dismiss(actor, id, NOTE, NOW)],
    ] as const;

    it.each(actions)("%s: два одновременных нажатия — одно занятие, одно задание, одна запись в журнале; второе получает 409", async (name, act) => {
      const discrepancy = open();
      s.store.barrier = 2;

      const results = await Promise.allSettled([act(s.service, admin, discrepancy.discrepancyId), act(s.service, admin, discrepancy.discrepancyId)]);

      const failed = results.filter((result) => result.status === "rejected");
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(PurchaseActionUnavailableError);
      expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409, message: ALREADY_RESOLVED });
      expect(s.store.claims).toHaveLength(2);
      expect(s.replayed.length + s.dispatched.length).toBe(name === "dismiss" ? 0 : 1);
      expect(s.rolesRepository.entries).toHaveLength(1);
      expect(s.events).toHaveLength(name === "dismiss" ? 0 : 1);
    });

    it.each(actions)("%s: уже закрытое расхождение — 409 «Расхождение уже разобрано», занятия нет", async (_name, act) => {
      const discrepancy = open({ resolvedAt: DETECTED_AT, resolution: "dismissed", resolvedBy: admin.accountId, note: "ложное" });

      const attempt = act(s.service, admin, discrepancy.discrepancyId);

      await expect(attempt).rejects.toBeInstanceOf(PurchaseActionUnavailableError);
      await expect(attempt).rejects.toMatchObject({ code: "purchase_action_unavailable", status: 409, message: ALREADY_RESOLVED });
      expect(s.store.claims).toEqual([]);
      expect(s.replayed).toEqual([]);
      expect(s.dispatched).toEqual([]);
      expect(s.rolesRepository.entries).toEqual([]);
    });

    it.each(actions)("%s: расхождения нет — 404 discrepancy_not_found «Расхождение не найдено»", async (_name, act) => {
      const attempt = act(s.service, admin, randomUUID());

      await expect(attempt).rejects.toBeInstanceOf(DiscrepancyNotFoundError);
      await expect(attempt).rejects.toMatchObject({ code: "discrepancy_not_found", status: 404, message: "Расхождение не найдено" });
      expect(s.store.claims).toEqual([]);
    });

    it.each(actions)("%s: оплата самого разбирающего — ForbiddenError «Разбирать свою оплату нельзя», расхождение остаётся открытым", async (_name, act) => {
      const own = row(admin.accountId);
      s.store.rows.push(own);

      const attempt = act(s.service, admin, own.discrepancyId);

      await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
      await expect(attempt).rejects.toMatchObject({ message: "Разбирать свою оплату нельзя" });
      expect(s.store.claims).toEqual([]);
      expect(s.replayed).toEqual([]);
      expect(s.dispatched).toEqual([]);
      expect(own.resolvedAt).toBeNull();
    });

    it.each(actions)("%s: со входом разработчика своя оплата разбирается — проверить на себе", async (_name, act) => {
      const dev = setup({ NODE_ENV: "development", AUTH_DEV_LOGIN: "true" });
      const me = await person(dev, "900010", "admin");
      const own = row(me.accountId);
      dev.store.rows.push(own);

      await expect(act(dev.service, me, own.discrepancyId)).resolves.toMatchObject({ discrepancyId: own.discrepancyId });
    });

    it.each(actions)("%s: закрытая своя оплата — 409 «уже разобрано», а не отказ про свою оплату: сначала проверяется закрытое", async (_name, act) => {
      const own = row(admin.accountId, { resolvedAt: DETECTED_AT, resolution: "matched" });
      s.store.rows.push(own);

      await expect(act(s.service, admin, own.discrepancyId)).rejects.toMatchObject({ status: 409, message: ALREADY_RESOLVED });
    });

    it.each(actions)("%s: без payments.support (модератор, гейм-дизайнер, игрок) — ForbiddenError, расхождение даже не читается", async (_name, act) => {
      const discrepancy = open();
      for (const role of ["moderator", "game_designer", undefined] as const) {
        const weak = await person(s, `9100${String(role?.length ?? 0)}`, role);

        await expect(act(s.service, weak, discrepancy.discrepancyId)).rejects.toBeInstanceOf(ForbiddenError);
      }

      expect(s.store.byIdCalls).toEqual([]);
      expect(s.store.claims).toEqual([]);
    });

    it.each(actions)("%s: владелец из списка окружения разбирает расхождение", async (_name, act) => {
      const owner = await person(s, OWNER_ID);
      const discrepancy = open();

      await expect(act(s.service, owner, discrepancy.discrepancyId)).resolves.toMatchObject({ discrepancyId: discrepancy.discrepancyId });
    });

    it("слушатель сообщения команде упал — действие уже выполнено, ответ приходит как обычно", async () => {
      const discrepancy = open();
      s.hooks.onSupport("сломанный", async () => {
        throw new Error("поток недоступен");
      });

      await expect(s.service.retry(admin, discrepancy.discrepancyId, NOTE, NOW)).resolves.toMatchObject({ resolution: "retried" });
    });

    it("имени актёра нет в аккаунтах — в сообщении команде и ответе его id или пусто, а не ошибка запроса", async () => {
      const discrepancy = open();
      const stranger: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: OWNER_ID };

      const view = await s.service.retry(stranger, discrepancy.discrepancyId, NOTE, NOW);

      expect(s.events[0]?.actorName).toBe(stranger.accountId);
      expect(view.resolvedByName).toBeNull();
    });

    it("идентификатор игрока на площадке — персональные данные: без players.pii.view в ответе его нет", async () => {
      vi.spyOn(s.roles, "can").mockImplementation(async (_actor, permission) => permission !== "players.pii.view");
      const discrepancy = open();

      const view = await s.service.dismiss(admin, discrepancy.discrepancyId, NOTE, NOW);

      expect(view.payerId).toBeNull();
    });
  });

  describe("retryableFor: что повторяет «Повторить учёт» в карточке платежа", () => {
    it("открытое «списано, но не записано» или «возврат не у нас» покупки — его id; самое раннее из них", async () => {
      const later = open({ kind: "refund_unrecorded", chargeId: "stx-later", detectedAt: new Date(DETECTED_AT.getTime() + 60_000) });
      const first = open({ chargeId: "stx-first" });

      expect(await s.service.retryableFor(PURCHASE_ID)).toBe(first.discrepancyId);
      s.store.rows = [later];
      expect(await s.service.retryableFor(PURCHASE_ID)).toBe(later.discrepancyId);
    });

    it.each([
      ["закрытое", { resolvedAt: NOW, resolution: "dismissed" as const }],
      ["«записано, но нет в выписке»", { kind: "recorded_missing" }],
      ["расхождение другой покупки", { purchaseId: OTHER_PURCHASE_ID }],
    ] satisfies [string, Partial<DiscrepancyRow>][])("%s — null", async (_name, patch) => {
      open(patch);

      expect(await s.service.retryableFor(PURCHASE_ID)).toBeNull();
    });

    it("расхождений нет — null", async () => {
      expect(await s.service.retryableFor(PURCHASE_ID)).toBeNull();
    });
  });

  describe("источник карточки платежа", () => {
    function purchaseOf(): StoredPurchase {
      return purchase(target.accountId);
    }

    it("открытое расхождение — строка «Сверка: <вид>» во время обнаружения", async () => {
      open();

      expect(await s.sources.timeline(purchaseOf())).toEqual([{ at: DETECTED_AT, kind: "discrepancy", text: "Сверка: Списано, но не записано", actorName: null }]);
    });

    it.each([
      ["charged_unrecorded", "Сверка: Списано, но не записано"],
      ["recorded_missing", "Сверка: Записано, но нет в выписке"],
      ["refund_unrecorded", "Сверка: Возврат в Telegram, но не у нас"],
    ])("подпись вида %s — «%s»", async (kind, text) => {
      open({ kind });

      expect((await s.sources.timeline(purchaseOf()))[0]?.text).toBe(text);
    });

    it.each([
      ["matched", "Расхождение закрыто: сошлось само", null],
      ["retried", "Расхождение закрыто: учёт повторён", "Анна из поддержки"],
      ["refunded", "Расхождение закрыто: звёзды возвращены", "Анна из поддержки"],
      ["dismissed", "Расхождение закрыто: разобрано", "Анна из поддержки"],
    ] as const)("закрытое решением %s — вторая строка во время закрытия, «%s», имя закрывшего: %s", async (resolution, text, actorName) => {
      const closedAt = new Date(DETECTED_AT.getTime() + 600_000);
      open({ resolution, resolvedAt: closedAt, resolvedBy: resolution === "matched" ? null : admin.accountId });

      const lines = await s.sources.timeline(purchaseOf());

      expect(lines).toEqual([
        { at: DETECTED_AT, kind: "discrepancy", text: "Сверка: Списано, но не записано", actorName: null },
        { at: closedAt, kind: "discrepancy", text, actorName },
      ]);
    });

    it("все расхождения покупки — каждое своими строками; чужой покупки среди них нет", async () => {
      open({ chargeId: "stx-a" });
      open({ kind: "refund_unrecorded", chargeId: "stx-b", resolvedAt: NOW, resolution: "matched" });
      open({ chargeId: "stx-other", purchaseId: OTHER_PURCHASE_ID });

      const lines = await s.sources.timeline(purchaseOf());

      expect(lines.map((line) => line.text)).toEqual(["Сверка: Списано, но не записано", "Сверка: Возврат в Telegram, но не у нас", "Расхождение закрыто: сошлось само"]);
    });

    it("расхождений нет — пустой вклад", async () => {
      expect(await s.sources.timeline(purchaseOf())).toEqual([]);
    });

    it("строка с незнакомым видом (запись более новой версии) пропускается с предупреждением, остальные на месте", async () => {
      open({ kind: "новый_вид", chargeId: "stx-new" });
      open({ chargeId: "stx-known" });

      const lines = await s.sources.timeline(purchaseOf());

      expect(lines.map((line) => line.text)).toEqual(["Сверка: Списано, но не записано"]);
      expect(logged.some((entry) => entry.level === "warn" && entry.fields.chargeId === "stx-new")).toBe(true);
    });

    it("пометка discrepancy — у покупок с открытым расхождением любого вида, одним запросом на страницу", async () => {
      const second = "33333333-3333-4333-8333-333333333333";
      const third = "44444444-4444-4444-8444-444444444444";
      open({ kind: "recorded_missing", chargeId: "stx-a" });
      open({ purchaseId: second, chargeId: "stx-b", resolvedAt: NOW, resolution: "matched" });

      const marks = await s.sources.marks([PURCHASE_ID, second, third]);

      expect([...marks]).toEqual([[PURCHASE_ID, ["discrepancy"]]]);
      expect(s.store.openByPurchasesCalls).toEqual([[PURCHASE_ID, second, third]]);
    });

    it("страница без покупок — запроса к базе нет", async () => {
      expect([...(await s.sources.marks([]))]).toEqual([]);
      expect(s.store.openByPurchasesCalls).toEqual([]);
    });

    it.each([
      ["charged_unrecorded", ["retry"]],
      ["refund_unrecorded", ["retry"]],
      ["recorded_missing", []],
    ])("действия по открытому %s — %j", async (kind, expected) => {
      open({ kind });

      expect(await s.sources.actions(purchaseOf())).toEqual(expected);
    });

    it("закрытое расхождение действий не открывает", async () => {
      open({ resolvedAt: NOW, resolution: "retried" });

      expect(await s.sources.actions(purchaseOf())).toEqual([]);
    });
  });
});
