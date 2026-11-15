import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION_METADATA } from "../src/common/access.js";
import { ForbiddenError, RateLimitedError, ValidationError } from "../src/common/domain-error.js";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { AdminPaymentCompensationController, compensateBodySchema } from "../src/modules/admin/admin-payment-compensation.controller.js";
import type { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { PaymentFeedSources } from "../src/modules/payments/payment-feed-sources.js";
import { CompensationFailedError, PurchaseActionUnavailableError, PurchaseNotFoundError } from "../src/modules/payments/payments-errors.js";
import { PaymentsHooks, type SupportAction } from "../src/modules/payments/payments-hooks.js";
import { PurchaseCompensations } from "../src/modules/payments/purchase-compensation.js";
import type { CompensationRow, PurchaseCompensationRepository } from "../src/modules/payments/purchase-compensation.repository.js";
import {
  COMPENSATION_REASON,
  COMPENSATION_RESOURCE,
  COMPENSATION_TEXTS,
  MANUAL_LOOKBACK_DAYS,
  compensationBlock,
  compensationKey,
  equivalentGems,
  suggestedGems,
} from "../src/modules/payments/purchase-compensation-rules.js";
import type { StoredPurchase } from "../src/modules/payments/purchase-types.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { vipRewardMul } from "../src/modules/vip/vip-plan.js";
import { EXCHANGE_RESOURCES } from "../src/modules/wallet/wallet-limits.js";
import type { CreditInput, CreditOutcome, WalletEntryRow, WalletRepository } from "../src/modules/wallet/wallet.repository.js";
import { WalletService } from "../src/modules/wallet/wallet.service.js";
import { emptyBalances, isEarnReason, type Balances } from "../src/modules/wallet/wallet-types.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPurchasesRepository } from "./helpers/memory-purchases.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Компенсация самоцветами за сбой оплаты, сервер (tasks/T-0435, Р209, WP53):
 * правила без Nest и Prisma, сервис на подставных покупках, ролях и журнале
 * кошелька, источник хронологии карточки платежа и маршруты панели. Одна
 * строка на покупку держится первичным ключом — её настоящая проверка на живом
 * Postgres в `purchase-compensation.integration.test.ts`.
 */

const NOW = new Date(Date.UTC(2026, 10, 12, 10));
const OWNER_ID = "777000111";
const NOTE = "Сбой оплаты 11.11: товар не пришёл, извиняемся";
const DAY_MS = 86_400_000;
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);

function config(env: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID, ...env } as NodeJS.ProcessEnv);
}

/** Оплаченная покупка: по умолчанию набор `gems_330` за 250 ⭐ — самоцветы в нём 330. */
function bought(accountId: string, patch: Partial<StoredPurchase> = {}): StoredPurchase {
  return {
    purchaseId: randomUUID(),
    accountId,
    product: "shop_item",
    runId: null,
    continueNo: null,
    elapsedSec: null,
    sku: "gems_330",
    priceStars: 250,
    chargedStars: 250,
    mode: "live",
    status: "paid",
    telegramChargeId: `charge-${randomUUID()}`,
    invoicedAt: daysAgo(1),
    paidAt: daysAgo(1),
    refundReason: null,
    refundRequestedAt: null,
    refundedAt: null,
    fulfilledAt: null,
    renewalOf: null,
    ...patch,
  };
}

describe("equivalentGems: во что покупка оценена в самоцветах", () => {
  const base = { sku: null, chargedStars: 10 } as const;

  it("второй шанс: звёзды по курсу второго шанса, 10 ⭐ → 12", () => {
    expect(equivalentGems({ ...base, product: "continue_run" })).toBe(12);
  });

  it("VIP: 700 ⭐ → 840", () => {
    expect(equivalentGems({ product: "vip", sku: "vip", chargedStars: 700 })).toBe(840);
  });

  it("набор магазина — его содержимое, а не уплаченное: gems_330 → 330", () => {
    expect(equivalentGems({ product: "shop_item", sku: "gems_330", chargedStars: 250 })).toBe(330);
    expect(equivalentGems({ product: "shop_item", sku: "starter", chargedStars: 50 })).toBe(150);
  });

  it("набора нет в каталоге — по уплаченным звёздам: 50 ⭐ → 60", () => {
    expect(equivalentGems({ product: "shop_item", sku: "retired_pack", chargedStars: 50 })).toBe(60);
    expect(equivalentGems({ product: "shop_item", sku: null, chargedStars: 50 })).toBe(60);
  });

  it("донат — эквивалента нет", () => {
    expect(equivalentGems({ product: "donation", sku: null, chargedStars: 100 })).toBeNull();
  });
});

describe("suggestedGems: что предлагает панель", () => {
  it("эквивалент на множитель: 840 × 2 → 1680", () => {
    expect(suggestedGems(840, 2, 2000)).toBe(1680);
  });

  it("не больше потолка: 1400 × 2 → 2000", () => {
    expect(suggestedGems(1400, 2, 2000)).toBe(2000);
  });

  it("эквивалента нет — предложения нет", () => {
    expect(suggestedGems(null, 2, 2000)).toBeNull();
  });
});

describe("compensationBlock: когда компенсировать нельзя", () => {
  const owner = randomUUID();
  const other = randomUUID();
  const live = { paidAt: NOW, product: "shop_item", mode: "live", accountId: owner } as const;
  const open = { devLogin: false, actorAccountId: other, credited: false };

  it("тексты — дословно", () => {
    expect(COMPENSATION_TEXTS).toEqual({
      unpaid: "Оплата не записана — сначала «Повторить учёт»",
      donation: "Донат не компенсируется: у него нет игровой ценности. Повторите учёт — знак мецената встанет сам",
      test: "Тестовая оплата — компенсировать нечего",
      own: "Компенсировать свою покупку нельзя",
      credited: "За эту покупку компенсация уже начислена",
    });
  });

  it("обычная оплаченная покупка — можно", () => {
    expect(compensationBlock(live, open)).toBeNull();
  });

  it("оплата не записана", () => {
    expect(compensationBlock({ ...live, paidAt: null }, open)).toBe("Оплата не записана — сначала «Повторить учёт»");
  });

  it("донат", () => {
    expect(compensationBlock({ ...live, product: "donation" }, open)).toBe("Донат не компенсируется: у него нет игровой ценности. Повторите учёт — знак мецената встанет сам");
  });

  it("тестовая оплата", () => {
    expect(compensationBlock({ ...live, mode: "test" }, open)).toBe("Тестовая оплата — компенсировать нечего");
  });

  it("своя покупка", () => {
    expect(compensationBlock(live, { ...open, actorAccountId: owner })).toBe("Компенсировать свою покупку нельзя");
  });

  it("уже начислена", () => {
    expect(compensationBlock(live, { ...open, credited: true })).toBe("За эту покупку компенсация уже начислена");
  });

  it("порядок проверок — как в решениях: оплата, донат, тест, своя, начислена", () => {
    const everything = { paidAt: null, product: "donation", mode: "test", accountId: owner } as const;
    const context = { devLogin: false, actorAccountId: owner, credited: true };

    expect(compensationBlock(everything, context)).toBe(COMPENSATION_TEXTS.unpaid);
    expect(compensationBlock({ ...everything, paidAt: NOW }, context)).toBe(COMPENSATION_TEXTS.donation);
    expect(compensationBlock({ ...everything, paidAt: NOW, product: "shop_item" }, context)).toBe(COMPENSATION_TEXTS.test);
    expect(compensationBlock({ ...everything, paidAt: NOW, product: "shop_item", mode: "live" }, context)).toBe(COMPENSATION_TEXTS.own);
    expect(compensationBlock({ ...everything, paidAt: NOW, product: "shop_item", mode: "live" }, { ...context, actorAccountId: other })).toBe(COMPENSATION_TEXTS.credited);
  });

  it("вход разработчика: тестовая оплата и своя покупка — можно", () => {
    expect(compensationBlock({ ...live, mode: "test" }, { devLogin: true, actorAccountId: owner, credited: false })).toBeNull();
  });

  it("вход разработчика не отменяет остальное: донат, неоплаченная и начисленная по-прежнему нельзя", () => {
    const dev = { devLogin: true, actorAccountId: owner, credited: false };

    expect(compensationBlock({ ...live, paidAt: null }, dev)).toBe(COMPENSATION_TEXTS.unpaid);
    expect(compensationBlock({ ...live, product: "donation" }, dev)).toBe(COMPENSATION_TEXTS.donation);
    expect(compensationBlock(live, { ...dev, credited: true })).toBe(COMPENSATION_TEXTS.credited);
  });

  it("актёра нет (источник ленты) — проверка своей покупки пропускается", () => {
    expect(compensationBlock(live, { devLogin: false, actorAccountId: null, credited: false })).toBeNull();
  });

  it("покупка с возвратом компенсируется: возврат правилом не закрыт", () => {
    // Возврат — поле покупки, а не её вид: в правило оно не входит вовсе.
    expect(compensationBlock({ ...live, ...{ refundedAt: NOW } }, open)).toBeNull();
  });
});

describe("ключ и причина кошелька", () => {
  it("ключ — одна компенсация на покупку", () => {
    expect(compensationKey("abc")).toBe("compensation:abc");
  });

  it("причина обмена и ресурс: только самоцветы", () => {
    expect(COMPENSATION_REASON).toBe("payment_compensation");
    expect(COMPENSATION_RESOURCE).toBe("gems");
    expect(MANUAL_LOOKBACK_DAYS).toBe(30);
  });
});

/** Журнал кошелька в памяти: ключ уникален, как в базе; `failCredits` — сколько ближайших начислений упадёт. */
class MemoryLedger implements WalletRepository {
  readonly entries: (WalletEntryRow & { accountId: string; idempotencyKey: string })[] = [];
  failCredits = 0;

  async credit(input: CreditInput): Promise<CreditOutcome> {
    if (this.failCredits > 0) {
      this.failCredits -= 1;
      throw new Error("база недоступна");
    }
    const existing = this.entries.find((entry) => entry.idempotencyKey === input.idempotencyKey);
    if (existing !== undefined) {
      return { status: "duplicate", existing: { accountId: existing.accountId, resource: existing.resource, reason: existing.reason, amount: existing.amount }, balance: this.balanceOf(input.accountId).gems };
    }
    this.add({ accountId: input.accountId, resource: input.resource, amount: input.amount, reason: input.reason, source: input.source, idempotencyKey: input.idempotencyKey, at: input.at });
    return { status: "credited", credited: input.amount, balance: this.balanceOf(input.accountId)[input.resource] };
  }

  async debit(): Promise<never> {
    throw new Error("компенсация ничего не списывает");
  }

  async balances(accountId: string): Promise<Balances> {
    return this.balanceOf(accountId);
  }

  async recentEntries(accountId: string, limit: number): Promise<WalletEntryRow[]> {
    return this.entries
      .filter((entry) => entry.accountId === accountId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  /** Запись, которая уже была в журнале до теста: «Кошелёк ±» или прежняя покупка. */
  add(entry: { accountId: string; resource: WalletEntryRow["resource"]; amount: number; reason: string; source?: string | null; idempotencyKey?: string; at: Date }): void {
    this.entries.push({
      entryId: randomUUID(),
      accountId: entry.accountId,
      resource: entry.resource,
      amount: entry.amount,
      reason: entry.reason,
      source: entry.source ?? null,
      idempotencyKey: entry.idempotencyKey ?? `seed:${randomUUID()}`,
      createdAt: entry.at,
    });
  }

  balanceOf(accountId: string): Balances {
    const balances = emptyBalances();
    for (const entry of this.entries) if (entry.accountId === accountId) balances[entry.resource] += entry.amount;
    return balances;
  }

  withReason(reason: string): number {
    return this.entries.filter((entry) => entry.reason === reason).length;
  }
}

/** Таблица компенсаций в памяти: первичный ключ — покупка, повторная вставка — `exists`. */
class MemoryCompensations implements PurchaseCompensationRepository {
  readonly rows = new Map<string, CompensationRow>();
  /** сколько раз вставку пробовали — чтобы видеть, что при готовой строке её не трогают */
  inserts = 0;

  async insert(row: CompensationRow): Promise<"inserted" | "exists"> {
    this.inserts += 1;
    if (this.rows.has(row.purchaseId)) return "exists";
    this.rows.set(row.purchaseId, { ...row });
    return "inserted";
  }

  async byPurchase(purchaseId: string): Promise<CompensationRow | null> {
    const row = this.rows.get(purchaseId);
    return row === undefined ? null : { ...row };
  }

  async byPurchases(purchaseIds: readonly string[]): Promise<Map<string, CompensationRow>> {
    return new Map(purchaseIds.flatMap((id) => (this.rows.has(id) ? [[id, { ...(this.rows.get(id) as CompensationRow) }] as const] : [])));
  }

  async markCredited(purchaseId: string, at: Date): Promise<boolean> {
    const row = this.rows.get(purchaseId);
    if (row === undefined || row.creditedAt !== null) return false;
    row.creditedAt = at;
    return true;
  }
}

function setup(env: Record<string, string> = {}, settings: Record<string, number> = {}) {
  const cfg = config(env);
  const accounts = new MemoryAccountRepository();
  const rolesRepository = new MemoryRolesRepository();
  const roles = new RolesService(cfg, rolesRepository, accounts);
  const purchases = new MemoryPurchasesRepository();
  const compensations = new MemoryCompensations();
  const ledger = new MemoryLedger();
  const wallet = new WalletService(ledger, cfg, roles);
  const hooks = new PaymentsHooks();
  const events: SupportAction[] = [];
  hooks.onSupport("тест", async (action) => {
    events.push(action);
  });
  const sources = new PaymentFeedSources();
  const service = new PurchaseCompensations(cfg, purchases, compensations, wallet, panelSettings(settings), roles, accounts, hooks, sources);
  service.onModuleInit();
  return { cfg, accounts, rolesRepository, roles, purchases, compensations, ledger, wallet, hooks, events, sources, service };
}

type Setup = ReturnType<typeof setup>;

async function person(s: Setup, id: string, role?: "admin" | "moderator", displayName = `Игрок ${id}`): Promise<AccountRef> {
  const account = await s.accounts.upsert({ platform: "telegram", platformUserId: id, displayName, username: null, photoUrl: null }, NOW.getTime());
  if (role !== undefined) await s.rolesRepository.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}

function put(s: Setup, purchase: StoredPurchase): StoredPurchase {
  s.purchases.rows.set(purchase.purchaseId, purchase);
  return purchase;
}

describe("compensate: начисление", () => {
  let s: Setup;
  let owner: AccountRef;
  let target: AccountRef;
  let logged: string[];

  beforeEach(async () => {
    s = setup();
    owner = await person(s, OWNER_ID, undefined, "Владелец Игорь");
    target = await person(s, "800002");
    logged = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("удача: самоцветы с ключом compensation:<id>, причиной payment_compensation и источником admin:<актёр>; отметка, журнал, сообщение, лог", async () => {
    const purchase = put(s, bought(target.accountId));

    const result = await s.service.compensate(owner, purchase.purchaseId, { gems: 660, note: NOTE }, NOW);

    expect(result).toEqual({ purchaseId: purchase.purchaseId, gems: 660, balance: 660, repaired: false });
    expect(s.ledger.entries).toHaveLength(1);
    expect(s.ledger.entries[0]).toMatchObject({
      accountId: target.accountId,
      resource: "gems",
      amount: 660,
      reason: "payment_compensation",
      source: `admin:${owner.accountId}`,
      idempotencyKey: `compensation:${purchase.purchaseId}`,
      createdAt: NOW,
    });
    expect(s.compensations.rows.get(purchase.purchaseId)).toEqual({
      purchaseId: purchase.purchaseId,
      accountId: target.accountId,
      resource: "gems",
      amount: 660,
      suggested: 660,
      note: NOTE,
      actorAccountId: owner.accountId,
      createdAt: NOW,
      creditedAt: NOW,
    });
    expect(s.rolesRepository.entries).toHaveLength(1);
    expect(s.rolesRepository.entries[0]).toMatchObject({
      actorAccountId: owner.accountId,
      action: "payments.compensate",
      target: target.accountId,
      after: { purchaseId: purchase.purchaseId, gems: 660, suggested: 660, note: NOTE },
    });
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({ kind: "compensate", actorName: "Владелец Игорь", note: NOTE, at: NOW, gems: 660 });
    expect(s.events[0]?.purchase.purchaseId).toBe(purchase.purchaseId);
    const line = JSON.parse(logged.find((entry) => entry.includes("purchase_compensated")) ?? "null") as Record<string, unknown>;
    expect(line).toMatchObject({ module: "payments", event: "purchase_compensated", purchaseId: purchase.purchaseId, accountId: target.accountId, gems: 660, suggested: 660, actorAccountId: owner.accountId });
  });

  it("сумму можно поправить: в строке и в журнале видно и её, и то, что предлагала панель", async () => {
    const purchase = put(s, bought(target.accountId));

    await s.service.compensate(owner, purchase.purchaseId, { gems: 100, note: NOTE }, NOW);

    expect(s.compensations.rows.get(purchase.purchaseId)).toMatchObject({ amount: 100, suggested: 660 });
    expect(s.rolesRepository.entries[0]?.after).toMatchObject({ gems: 100, suggested: 660 });
    expect(s.ledger.entries[0]?.amount).toBe(100);
  });

  it("набор, которого нет в каталоге: строка хранит предложение по уплаченным звёздам, 50 ⭐ → 60 → 120", async () => {
    const purchase = put(s, bought(target.accountId, { product: "shop_item", sku: "retired_pack", chargedStars: 50, priceStars: 50 }));

    await s.service.compensate(owner, purchase.purchaseId, { gems: 100, note: NOTE }, NOW);

    expect(s.compensations.rows.get(purchase.purchaseId)).toMatchObject({ amount: 100, suggested: 120 });
  });

  it("возвращённая покупка компенсируется", async () => {
    const purchase = put(s, bought(target.accountId, { status: "refunded", refundReason: "manual", refundRequestedAt: daysAgo(0.5), refundedAt: daysAgo(0.4) }));

    const result = await s.service.compensate(owner, purchase.purchaseId, { gems: 330, note: NOTE }, NOW);

    expect(result.gems).toBe(330);
  });

  it("надбавки VIP к компенсации нет: она не из причин заработка, суточного потолка тоже нет", () => {
    expect(vipRewardMul(COMPENSATION_REASON)).toBeUndefined();
    expect(isEarnReason(COMPENSATION_REASON)).toBe(false);
    expect(EXCHANGE_RESOURCES.payment_compensation).toEqual(["gems"]);
  });

  it("вторая компенсация после начисленной — 409 «За эту покупку компенсация уже начислена», кошелёк не зовётся", async () => {
    const purchase = put(s, bought(target.accountId));
    await s.service.compensate(owner, purchase.purchaseId, { gems: 660, note: NOTE }, NOW);

    const second = s.service.compensate(owner, purchase.purchaseId, { gems: 100, note: "ещё раз" }, NOW);

    await expect(second).rejects.toBeInstanceOf(PurchaseActionUnavailableError);
    await expect(second).rejects.toMatchObject({ code: "purchase_action_unavailable", status: 409, message: "За эту покупку компенсация уже начислена" });
    expect(s.ledger.entries).toHaveLength(1);
    expect(s.rolesRepository.entries).toHaveLength(1);
    expect(s.events).toHaveLength(1);
  });

  it("двойное нажатие: два вызова разом — одно начисление, одна запись журнала и одно сообщение", async () => {
    const purchase = put(s, bought(target.accountId));

    const outcomes = await Promise.allSettled([
      s.service.compensate(owner, purchase.purchaseId, { gems: 600, note: NOTE }, NOW),
      s.service.compensate(owner, purchase.purchaseId, { gems: 700, note: NOTE }, NOW),
    ]);

    expect(s.compensations.rows.size).toBe(1);
    expect(s.ledger.withReason("payment_compensation")).toBe(1);
    expect(s.ledger.balanceOf(target.accountId).gems).toBe(600);
    expect(s.rolesRepository.entries).toHaveLength(1);
    expect(s.events).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") expect(outcome.value.gems).toBe(600);
      else expect(outcome.reason).toMatchObject({ message: "За эту покупку компенсация уже начислена" });
    }
    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);
  });

  it("кошелёк упал: строка есть без отметки, ни журнала, ни сообщения; ошибка с понятным текстом", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const purchase = put(s, bought(target.accountId));
    s.ledger.failCredits = 1;

    const attempt = s.service.compensate(owner, purchase.purchaseId, { gems: 660, note: NOTE }, NOW);

    await expect(attempt).rejects.toBeInstanceOf(CompensationFailedError);
    await expect(attempt).rejects.toMatchObject({ code: "compensation_failed", status: 503 });
    expect(s.compensations.rows.get(purchase.purchaseId)).toMatchObject({ amount: 660, creditedAt: null });
    expect(s.ledger.entries).toEqual([]);
    expect(s.rolesRepository.entries).toEqual([]);
    expect(s.events).toEqual([]);
  });

  it("повтор после сбоя кошелька с другой суммой доначисляет сумму из строки; журнал и сообщение — один раз за обе попытки", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const purchase = put(s, bought(target.accountId));
    s.ledger.failCredits = 1;
    await expect(s.service.compensate(owner, purchase.purchaseId, { gems: 660, note: NOTE }, NOW)).rejects.toBeInstanceOf(CompensationFailedError);
    const later = new Date(NOW.getTime() + 60_000);

    const result = await s.service.compensate(owner, purchase.purchaseId, { gems: 1, note: "другая причина" }, later);

    expect(result).toEqual({ purchaseId: purchase.purchaseId, gems: 660, balance: 660, repaired: true });
    expect(s.ledger.entries).toHaveLength(1);
    expect(s.ledger.entries[0]).toMatchObject({ amount: 660, idempotencyKey: `compensation:${purchase.purchaseId}` });
    expect(s.compensations.rows.get(purchase.purchaseId)).toMatchObject({ amount: 660, note: NOTE, creditedAt: later });
    expect(s.rolesRepository.entries).toHaveLength(1);
    expect(s.rolesRepository.entries[0]?.after).toMatchObject({ gems: 660, note: NOTE });
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({ gems: 660, note: NOTE, at: later });
  });

  it("при готовой строке сумма из запроса не проверяется по потолку: берётся сумма строки", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const purchase = put(s, bought(target.accountId));
    s.ledger.failCredits = 1;
    await expect(s.service.compensate(owner, purchase.purchaseId, { gems: 660, note: NOTE }, NOW)).rejects.toBeInstanceOf(CompensationFailedError);

    const result = await s.service.compensate(owner, purchase.purchaseId, { gems: 20_000, note: NOTE }, NOW);

    expect(result).toMatchObject({ gems: 660, repaired: true });
  });

  it("отметку успел поставить другой вызов: ни второго журнала, ни второго сообщения", async () => {
    const purchase = put(s, bought(target.accountId));
    vi.spyOn(s.compensations, "markCredited").mockResolvedValue(false);

    const result = await s.service.compensate(owner, purchase.purchaseId, { gems: 660, note: NOTE }, NOW);

    expect(result.gems).toBe(660);
    expect(s.rolesRepository.entries).toEqual([]);
    expect(s.events).toEqual([]);
    expect(logged.some((line) => line.includes("purchase_compensated"))).toBe(false);
  });

  it("больше потолка — ValidationError с текстом про «Настройки», строки и начисления нет", async () => {
    const purchase = put(s, bought(target.accountId));

    const attempt = s.service.compensate(owner, purchase.purchaseId, { gems: 2001, note: NOTE }, NOW);

    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt).rejects.toMatchObject({ message: "Больше потолка: 2000 самоцветов — его меняют в «Настройках», ключ «Потолок компенсации»" });
    expect(s.compensations.rows.size).toBe(0);
    expect(s.ledger.entries).toEqual([]);
  });

  it("ровно потолок — проходит; потолок берётся из настроек", async () => {
    const custom = setup({}, { "payments.compensation.max-gems": 500 });
    const boss = await person(custom, OWNER_ID);
    const player = await person(custom, "800004");
    const purchase = put(custom, bought(player.accountId));

    await expect(custom.service.compensate(boss, purchase.purchaseId, { gems: 501, note: NOTE }, NOW)).rejects.toMatchObject({ message: expect.stringContaining("Больше потолка: 500 самоцветов") });
    const result = await custom.service.compensate(boss, purchase.purchaseId, { gems: 500, note: NOTE }, NOW);

    expect(result.gems).toBe(500);
  });

  it.each([[0], [-5], [1.5], [Number.NaN]])("сумма %s — ValidationError, ничего не записано", async (gems) => {
    const purchase = put(s, bought(target.accountId));

    await expect(s.service.compensate(owner, purchase.purchaseId, { gems, note: NOTE }, NOW)).rejects.toBeInstanceOf(ValidationError);

    expect(s.compensations.rows.size).toBe(0);
    expect(s.ledger.entries).toEqual([]);
  });

  it("без payments.compensate — ForbiddenError, покупка не читается (админ права не имеет)", async () => {
    const support = await person(s, "800010", "admin");
    const purchase = put(s, bought(target.accountId));
    const byId = vi.spyOn(s.purchases, "byId");

    await expect(s.service.compensate(support, purchase.purchaseId, { gems: 100, note: NOTE }, NOW)).rejects.toBeInstanceOf(ForbiddenError);

    expect(byId).not.toHaveBeenCalled();
    expect(s.ledger.entries).toEqual([]);
  });

  it("покупки нет — PurchaseNotFoundError", async () => {
    await expect(s.service.compensate(owner, randomUUID(), { gems: 100, note: NOTE }, NOW)).rejects.toBeInstanceOf(PurchaseNotFoundError);
  });

  it("своя покупка — ForbiddenError «Компенсировать свою покупку нельзя»", async () => {
    const own = put(s, bought(owner.accountId));

    const attempt = s.service.compensate(owner, own.purchaseId, { gems: 100, note: NOTE }, NOW);

    await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
    await expect(attempt).rejects.toMatchObject({ message: "Компенсировать свою покупку нельзя" });
    expect(s.ledger.entries).toEqual([]);
  });

  it("своя покупка и тестовая оплата на машине разработчика — проходят: проверить на себе", async () => {
    const dev = setup({ NODE_ENV: "development", AUTH_DEV_LOGIN: "true" });
    const me = await person(dev, OWNER_ID);
    const own = put(dev, bought(me.accountId, { mode: "test", chargedStars: 1, priceStars: 250 }));

    const result = await dev.service.compensate(me, own.purchaseId, { gems: 100, note: NOTE }, NOW);

    expect(result.gems).toBe(100);
  });

  it.each([
    ["оплата не записана", { status: "pending", paidAt: null, telegramChargeId: null }, "Оплата не записана — сначала «Повторить учёт»"],
    ["донат", { product: "donation", sku: null }, "Донат не компенсируется: у него нет игровой ценности. Повторите учёт — знак мецената встанет сам"],
    ["тестовая оплата", { mode: "test", chargedStars: 1 }, "Тестовая оплата — компенсировать нечего"],
  ] as const)("%s — 409 с текстом из решений, ничего не записано", async (_name, patch, message) => {
    const purchase = put(s, bought(target.accountId, patch));

    const attempt = s.service.compensate(owner, purchase.purchaseId, { gems: 100, note: NOTE }, NOW);

    await expect(attempt).rejects.toBeInstanceOf(PurchaseActionUnavailableError);
    await expect(attempt).rejects.toMatchObject({ code: "purchase_action_unavailable", status: 409, message });
    expect(s.compensations.inserts).toBe(0);
    expect(s.ledger.entries).toEqual([]);
    expect(s.rolesRepository.entries).toEqual([]);
    expect(s.events).toEqual([]);
  });

  it("упавший журнал действий не отменяет начисление, а сообщение команде всё равно уходит", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    s.rolesRepository.failAudit = true;
    const purchase = put(s, bought(target.accountId));

    const result = await s.service.compensate(owner, purchase.purchaseId, { gems: 660, note: NOTE }, NOW);

    expect(result.gems).toBe(660);
    expect(s.events).toHaveLength(1);
  });

  it("слушатель сообщения упал — начисление и ответ целы", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    s.hooks.onSupport("сломанный", async () => Promise.reject(new Error("чат недоступен")));
    const purchase = put(s, bought(target.accountId));

    const result = await s.service.compensate(owner, purchase.purchaseId, { gems: 660, note: NOTE }, NOW);

    expect(result.gems).toBe(660);
    expect(s.events).toHaveLength(1);
  });

  it("имени актёра нет — в сообщении команде стоит его id", async () => {
    const stranger: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: OWNER_ID };
    const purchase = put(s, bought(target.accountId));

    await s.service.compensate(stranger, purchase.purchaseId, { gems: 100, note: NOTE }, NOW);

    expect(s.events[0]?.actorName).toBe(stranger.accountId);
  });
});

describe("preview: предложение", () => {
  let s: Setup;
  let owner: AccountRef;
  let target: AccountRef;

  beforeEach(async () => {
    s = setup();
    owner = await person(s, OWNER_ID, undefined, "Владелец Игорь");
    target = await person(s, "810002");
  });

  it("набор gems_330: эквивалент 330, множитель 2, предложение 660, потолок 2000", async () => {
    const purchase = put(s, bought(target.accountId));

    const preview = await s.service.preview(owner, purchase.purchaseId, NOW);

    expect(preview).toEqual({
      purchaseId: purchase.purchaseId,
      blockedReason: null,
      chargedStars: 250,
      equivalentGems: 330,
      multiplier: 2,
      suggestedGems: 660,
      maxGems: 2000,
      existing: null,
      recentManual: [],
    });
  });

  it("VIP за 700 ⭐: эквивалент 840, предложение 1680", async () => {
    const purchase = put(s, bought(target.accountId, { product: "vip", sku: "vip", chargedStars: 700, priceStars: 700 }));

    const preview = await s.service.preview(owner, purchase.purchaseId, NOW);

    expect(preview).toMatchObject({ equivalentGems: 840, suggestedGems: 1680 });
  });

  it("второй шанс: по курсу, 10 ⭐ → 12 → 24", async () => {
    const purchase = put(s, bought(target.accountId, { product: "continue_run", sku: null, runId: "run-1", continueNo: 1, elapsedSec: 90, chargedStars: 10, priceStars: 10 }));

    const preview = await s.service.preview(owner, purchase.purchaseId, NOW);

    expect(preview).toMatchObject({ equivalentGems: 12, suggestedGems: 24 });
  });

  it("донат: эквивалента и предложения нет, причина — текст из решений", async () => {
    const purchase = put(s, bought(target.accountId, { product: "donation", sku: null }));

    const preview = await s.service.preview(owner, purchase.purchaseId, NOW);

    expect(preview).toMatchObject({ equivalentGems: null, suggestedGems: null, blockedReason: COMPENSATION_TEXTS.donation });
  });

  it("множитель и потолок — из настроек панели", async () => {
    const custom = setup({}, { "payments.compensation.multiplier": 3, "payments.compensation.max-gems": 900 });
    const boss = await person(custom, OWNER_ID);
    const player = await person(custom, "810003");
    const purchase = put(custom, bought(player.accountId));

    const preview = await custom.service.preview(boss, purchase.purchaseId, NOW);

    expect(preview).toMatchObject({ multiplier: 3, maxGems: 900, equivalentGems: 330, suggestedGems: 900 });
  });

  it("ключи настроек — в каталоге, умолчания 2 и 2000", () => {
    expect(SETTINGS.paymentsCompensationMultiplier).toMatchObject({ key: "payments.compensation.multiplier", group: "Платежи", fallback: 2, range: { min: 1, max: 5 } });
    expect(SETTINGS.paymentsCompensationMaxGems).toMatchObject({ key: "payments.compensation.max-gems", group: "Платежи", fallback: 2000, range: { min: 1, max: 20_000 } });
  });

  it("своя покупка и неоплаченная — причина в ответе, а не ошибка", async () => {
    const own = put(s, bought(owner.accountId));
    const unpaid = put(s, bought(target.accountId, { status: "pending", paidAt: null, telegramChargeId: null }));

    expect((await s.service.preview(owner, own.purchaseId, NOW)).blockedReason).toBe(COMPENSATION_TEXTS.own);
    expect((await s.service.preview(owner, unpaid.purchaseId, NOW)).blockedReason).toBe(COMPENSATION_TEXTS.unpaid);
  });

  it("уже начислена: причина и что именно начислено, кем и когда", async () => {
    const purchase = put(s, bought(target.accountId));
    await s.service.compensate(owner, purchase.purchaseId, { gems: 500, note: NOTE }, NOW);

    const preview = await s.service.preview(owner, purchase.purchaseId, new Date(NOW.getTime() + 1000));

    expect(preview.blockedReason).toBe(COMPENSATION_TEXTS.credited);
    expect(preview.existing).toEqual({ gems: 500, suggested: 660, note: NOTE, actorName: "Владелец Игорь", createdAt: NOW, credited: true });
  });

  it("записана, но не начислена: покупка не закрыта, строка видна с credited: false", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const purchase = put(s, bought(target.accountId));
    s.ledger.failCredits = 1;
    await expect(s.service.compensate(owner, purchase.purchaseId, { gems: 500, note: NOTE }, NOW)).rejects.toBeInstanceOf(CompensationFailedError);

    const preview = await s.service.preview(owner, purchase.purchaseId, NOW);

    expect(preview.blockedReason).toBeNull();
    expect(preview.existing).toMatchObject({ gems: 500, credited: false });
  });

  it("recentManual: только «Кошелёк ±» в плюс за последние 30 суток — без списаний, старых и чужих причин", async () => {
    const purchase = put(s, bought(target.accountId));
    s.ledger.add({ accountId: target.accountId, resource: "gems", amount: 100, reason: "admin_adjust", at: daysAgo(5) });
    s.ledger.add({ accountId: target.accountId, resource: "coins", amount: 2000, reason: "admin_adjust", at: daysAgo(2) });
    s.ledger.add({ accountId: target.accountId, resource: "gems", amount: -50, reason: "admin_adjust", at: daysAgo(3) });
    s.ledger.add({ accountId: target.accountId, resource: "gems", amount: 200, reason: "admin_adjust", at: daysAgo(40) });
    s.ledger.add({ accountId: target.accountId, resource: "gems", amount: 330, reason: "purchase", at: daysAgo(1) });
    s.ledger.add({ accountId: randomUUID(), resource: "gems", amount: 999, reason: "admin_adjust", at: daysAgo(1) });

    const preview = await s.service.preview(owner, purchase.purchaseId, NOW);

    expect(preview.recentManual).toEqual([
      { at: daysAgo(2), resource: "coins", amount: 2000 },
      { at: daysAgo(5), resource: "gems", amount: 100 },
    ]);
  });

  it("ровно тридцать суток назад — ещё в окне, на секунду раньше — уже нет", async () => {
    const purchase = put(s, bought(target.accountId));
    s.ledger.add({ accountId: target.accountId, resource: "gems", amount: 10, reason: "admin_adjust", at: daysAgo(30) });
    s.ledger.add({ accountId: target.accountId, resource: "gems", amount: 20, reason: "admin_adjust", at: new Date(daysAgo(30).getTime() - 1000) });

    const preview = await s.service.preview(owner, purchase.purchaseId, NOW);

    expect(preview.recentManual.map((entry) => entry.amount)).toEqual([10]);
  });

  it("без payments.compensate — ForbiddenError, покупка и кошелёк не читаются", async () => {
    const support = await person(s, "810010", "admin");
    const purchase = put(s, bought(target.accountId));
    const byId = vi.spyOn(s.purchases, "byId");
    const recent = vi.spyOn(s.ledger, "recentEntries");

    await expect(s.service.preview(support, purchase.purchaseId, NOW)).rejects.toBeInstanceOf(ForbiddenError);

    expect(byId).not.toHaveBeenCalled();
    expect(recent).not.toHaveBeenCalled();
  });

  it("покупки нет — PurchaseNotFoundError", async () => {
    await expect(s.service.preview(owner, randomUUID(), NOW)).rejects.toBeInstanceOf(PurchaseNotFoundError);
  });
});

describe("источник хронологии карточки платежа", () => {
  let s: Setup;
  let owner: AccountRef;
  let target: AccountRef;

  beforeEach(async () => {
    s = setup();
    owner = await person(s, OWNER_ID, undefined, "Владелец Игорь");
    target = await person(s, "820002");
  });

  it("начисленная: строка compensated со временем начисления, суммой, причиной и именем актёра; пометка compensated", async () => {
    const purchase = put(s, bought(target.accountId));
    await s.service.compensate(owner, purchase.purchaseId, { gems: 660, note: NOTE }, NOW);

    const timeline = await s.sources.timeline(purchase);
    const marks = await s.sources.marks([purchase.purchaseId, randomUUID()]);

    expect(timeline).toEqual([{ at: NOW, kind: "compensated", text: `Компенсация: 660 самоцветов — ${NOTE}`, actorName: "Владелец Игорь" }]);
    expect(marks.get(purchase.purchaseId)).toEqual(["compensated"]);
    expect(marks.size).toBe(1);
  });

  it("сумма склоняется: 1 самоцвет, 22 самоцвета", async () => {
    const one = put(s, bought(target.accountId));
    const many = put(s, bought(target.accountId));
    await s.service.compensate(owner, one.purchaseId, { gems: 1, note: NOTE }, NOW);
    await s.service.compensate(owner, many.purchaseId, { gems: 22, note: NOTE }, NOW);

    expect((await s.sources.timeline(one))[0]?.text).toBe(`Компенсация: 1 самоцвет — ${NOTE}`);
    expect((await s.sources.timeline(many))[0]?.text).toBe(`Компенсация: 22 самоцвета — ${NOTE}`);
  });

  it("строка не длиннее двухсот знаков, как у остальных строк хронологии", async () => {
    const purchase = put(s, bought(target.accountId));
    await s.service.compensate(owner, purchase.purchaseId, { gems: 660, note: "я".repeat(200) }, NOW);

    const [line] = await s.sources.timeline(purchase);

    expect([...(line?.text ?? "")]).toHaveLength(200);
    expect(line?.text.endsWith("…")).toBe(true);
  });

  it("записанная без начисления: строка во время создания, пометки нет", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const purchase = put(s, bought(target.accountId));
    s.ledger.failCredits = 1;
    await expect(s.service.compensate(owner, purchase.purchaseId, { gems: 660, note: NOTE }, NOW)).rejects.toBeInstanceOf(CompensationFailedError);

    const timeline = await s.sources.timeline(purchase);
    const marks = await s.sources.marks([purchase.purchaseId]);

    expect(timeline).toEqual([{ at: NOW, kind: "compensated", text: "Компенсация записана, но не начислена — нажмите «Компенсировать» ещё раз", actorName: "Владелец Игорь" }]);
    expect(marks.size).toBe(0);
  });

  it("без компенсации — ни строк, ни пометок", async () => {
    const purchase = put(s, bought(target.accountId));

    expect(await s.sources.timeline(purchase)).toEqual([]);
    expect((await s.sources.marks([purchase.purchaseId])).size).toBe(0);
  });

  it("действие compensate открыто, пока компенсации нет, и пропадает после начисления", async () => {
    const purchase = put(s, bought(target.accountId));
    expect(await s.sources.actions(purchase)).toEqual(["compensate"]);

    await s.service.compensate(owner, purchase.purchaseId, { gems: 660, note: NOTE }, NOW);

    expect(await s.sources.actions(purchase)).toEqual([]);
  });

  it("действие остаётся, если начисление не прошло: повтор доделает", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const purchase = put(s, bought(target.accountId));
    s.ledger.failCredits = 1;
    await expect(s.service.compensate(owner, purchase.purchaseId, { gems: 660, note: NOTE }, NOW)).rejects.toBeInstanceOf(CompensationFailedError);

    expect(await s.sources.actions(purchase)).toEqual(["compensate"]);
  });

  it.each([
    ["оплата не записана", { status: "pending", paidAt: null, telegramChargeId: null }],
    ["донат", { product: "donation", sku: null }],
    ["тестовая оплата", { mode: "test", chargedStars: 1 }],
  ] as const)("%s — действия нет", async (_name, patch) => {
    expect(await s.sources.actions(bought(target.accountId, patch))).toEqual([]);
  });

  it("возвращённая покупка — действие есть; своей покупки источник не отсекает: актёра он не знает, решает сервис", async () => {
    expect(await s.sources.actions(bought(target.accountId, { status: "refunded", refundedAt: NOW }))).toEqual(["compensate"]);
    expect(await s.sources.actions(bought(owner.accountId))).toEqual(["compensate"]);
  });

  it("на машине разработчика тестовая оплата компенсируется — действие есть", async () => {
    const dev = setup({ NODE_ENV: "development", AUTH_DEV_LOGIN: "true" });
    const player = await person(dev, "820003");

    expect(await dev.sources.actions(bought(player.accountId, { mode: "test", chargedStars: 1 }))).toEqual(["compensate"]);
  });
});

describe("AdminPaymentCompensationController: маршруты", () => {
  const actor: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: OWNER_ID };
  const request = { account: actor };
  const purchaseId = randomUUID();

  function controller(allowed = true) {
    const calls: { method: string; args: unknown[] }[] = [];
    const service = {
      preview: async (...args: unknown[]) => {
        calls.push({ method: "preview", args });
        return { purchaseId };
      },
      compensate: async (...args: unknown[]) => {
        calls.push({ method: "compensate", args });
        return { purchaseId, gems: 660, balance: 660, repaired: false };
      },
    } as unknown as PurchaseCompensations;
    const limiter = { consume: async () => allowed } as unknown as RateLimiter;
    return { routes: new AdminPaymentCompensationController(service, limiter), calls };
  }

  it("оба маршрута — под payments.compensate, запись отвечает 200", () => {
    expect(Reflect.getMetadata(PERMISSION_METADATA, AdminPaymentCompensationController.prototype.preview)).toBe("payments.compensate");
    expect(Reflect.getMetadata(PERMISSION_METADATA, AdminPaymentCompensationController.prototype.compensate)).toBe("payments.compensate");
    expect(Reflect.getMetadata("__httpCode__", AdminPaymentCompensationController.prototype.compensate)).toBe(200);
  });

  it("предложение: покупка и актёр доходят до сервиса, ответ — в { data }", async () => {
    const { routes, calls } = controller();

    const response = await routes.preview(request, purchaseId);

    expect(response).toEqual({ data: { purchaseId } });
    expect(calls[0]?.method).toBe("preview");
    expect(calls[0]?.args.slice(0, 2)).toEqual([actor, purchaseId]);
  });

  it("начисление: сумма и причина без пробелов по краям доходят до сервиса", async () => {
    const { routes, calls } = controller();

    const response = await routes.compensate(request, purchaseId, { gems: 660, note: `  ${NOTE}  ` });

    expect(response).toEqual({ data: { purchaseId, gems: 660, balance: 660, repaired: false } });
    expect(calls[0]?.method).toBe("compensate");
    expect(calls[0]?.args.slice(0, 3)).toEqual([actor, purchaseId, { gems: 660, note: NOTE }]);
  });

  it.each([
    ["нет тела", undefined],
    ["нет суммы", { note: NOTE }],
    ["нет причины", { gems: 100 }],
    ["сумма ноль", { gems: 0, note: NOTE }],
    ["сумма дробная", { gems: 1.5, note: NOTE }],
    ["сумма строкой", { gems: "100", note: NOTE }],
    ["сумма больше 20 000", { gems: 20_001, note: NOTE }],
    ["причина из двух знаков", { gems: 100, note: "ок" }],
    ["причина из пробелов", { gems: 100, note: "     " }],
    ["причина длиннее двухсот знаков", { gems: 100, note: "я".repeat(201) }],
    ["лишнее поле", { gems: 100, note: NOTE, resource: "coins" }],
  ] as const)("%s — ValidationError с понятным текстом, сервис не зовётся", async (_name, body) => {
    const { routes, calls } = controller();

    const attempt = routes.compensate(request, purchaseId, body);

    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt).rejects.toMatchObject({ message: "Укажите сумму от 1 самоцвета и причину от 3 до 200 символов" });
    expect(calls).toEqual([]);
  });

  it("границы тела: 1 и 20 000 самоцветов, причина ровно из трёх и ровно из двухсот знаков — проходят", () => {
    expect(compensateBodySchema.safeParse({ gems: 1, note: "три" }).success).toBe(true);
    expect(compensateBodySchema.safeParse({ gems: 20_000, note: "я".repeat(200) }).success).toBe(true);
  });

  it("purchaseId не UUID — ValidationError «Некорректный идентификатор покупки», сервис не зовётся", async () => {
    const { routes, calls } = controller();

    await expect(routes.preview(request, "не-uuid")).rejects.toMatchObject({ message: "Некорректный идентификатор покупки" });
    await expect(routes.compensate(request, "не-uuid", { gems: 100, note: NOTE })).rejects.toMatchObject({ message: "Некорректный идентификатор покупки" });
    expect(calls).toEqual([]);
  });

  it("лимит частоты исчерпан — RateLimitedError, сервис не зовётся", async () => {
    const { routes, calls } = controller(false);

    await expect(routes.compensate(request, purchaseId, { gems: 100, note: NOTE })).rejects.toBeInstanceOf(RateLimitedError);
    expect(calls).toEqual([]);
  });
});
