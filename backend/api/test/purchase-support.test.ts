import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "../src/common/domain-error.js";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { PaymentRefunds } from "../src/modules/payments/payment-refunds.js";
import { FulfillFailedError, PurchaseActionUnavailableError, PurchaseNotFoundError, PurchaseUndeliverableError } from "../src/modules/payments/payments-errors.js";
import { PaymentsHooks, type SupportAction } from "../src/modules/payments/payments-hooks.js";
import type { PaymentsQueue } from "../src/modules/payments/payments-queue.js";
import { PurchaseFulfillment, UndeliverableError } from "../src/modules/payments/purchase-fulfillment.js";
import { PurchaseRevocation } from "../src/modules/payments/purchase-revocation.js";
import { PurchaseSupport } from "../src/modules/payments/purchase-support.js";
import type { StoredPurchase } from "../src/modules/payments/purchase-types.js";
import type { RefundOrder } from "../src/modules/payments/purchases.repository.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { TelegramApiError } from "../src/platforms/telegram/telegram-bot-api.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { FakeStarsApi, starsProviders } from "./helpers/fake-stars-api.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPurchasesRepository } from "./helpers/memory-purchases.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Поддержка покупок (tasks/T-0037): вернуть звёзды и повторить выдачу. Сервис
 * проверяется на подменах: покупки, роли и звёзды — в памяти, очередь — шпион.
 * Закрепляется то, где такое действие ломается: чужая покупка, своя покупка,
 * повтор нажатия, выдача, упавшая не по сути товара, и порядок «звёзды ушли —
 * потом забираем остаток».
 */

const NOW = new Date(Date.UTC(2026, 9, 7, 12));
const OWNER_ID = "777000111";
const NOTE = "Игрок написал в поддержку: покупка не пришла";

function config(env: Record<string, string> = {}): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: OWNER_ID, ...env } as NodeJS.ProcessEnv);
}

/** Оплаченный товар магазина: по умолчанию выдан и без возврата. */
function shopItem(accountId: string, patch: Partial<StoredPurchase> = {}): StoredPurchase {
  return {
    purchaseId: randomUUID(),
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
    telegramChargeId: `charge-${randomUUID()}`,
    invoicedAt: new Date(NOW.getTime() - 3_600_000),
    paidAt: new Date(NOW.getTime() - 3_000_000),
    refundReason: null,
    refundRequestedAt: null,
    refundedAt: null,
    fulfilledAt: new Date(NOW.getTime() - 3_000_000),
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
  const api = new FakeStarsApi();

  const revoked: { purchaseId: string; at: Date }[] = [];
  const revocation = new PurchaseRevocation();
  revocation.register("shop_item", async (purchase, at) => {
    revoked.push({ purchaseId: purchase.purchaseId, at });
    return { lines: ["самоцветы: 120 из 150"] };
  });

  const fulfilled: string[] = [];
  const fulfillment = new PurchaseFulfillment();
  fulfillment.register("shop_item", async (purchase) => {
    fulfilled.push(purchase.purchaseId);
  });

  const refunds = new PaymentRefunds(purchases, starsProviders(api), revocation);
  const dispatched: RefundOrder[] = [];
  const queue = {
    dispatchRefunds: async (orders: Promise<RefundOrder[]>) => {
      dispatched.push(...(await orders));
    },
  } as unknown as PaymentsQueue;

  const hooks = new PaymentsHooks();
  const events: SupportAction[] = [];
  hooks.onSupport("тест", async (action) => {
    events.push(action);
  });

  const support = new PurchaseSupport(cfg, purchases, accounts, roles, fulfillment, refunds, queue, hooks);
  return { cfg, accounts, rolesRepository, roles, purchases, api, revoked, revocation, fulfilled, fulfillment, refunds, dispatched, events, hooks, support };
}

type Setup = ReturnType<typeof setup>;

async function person(s: Setup, id: string, role?: "admin" | "moderator" | "game_designer", displayName = `Игрок ${id}`): Promise<AccountRef> {
  const account = await s.accounts.upsert({ platform: "telegram", platformUserId: id, displayName, username: null, photoUrl: null }, NOW.getTime());
  if (role !== undefined) await s.rolesRepository.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}

/** Покупка игрока в хранилище; Telegram ID владельца нужен заказу возврата — он знает, кому вернуть. */
function put(s: Setup, purchase: StoredPurchase): StoredPurchase {
  s.purchases.rows.set(purchase.purchaseId, purchase);
  s.purchases.owners.set(purchase.accountId, "555000111");
  return purchase;
}

describe("что открыто по покупке", () => {
  let s: Setup;
  const player = randomUUID();

  beforeEach(() => {
    s = setup();
  });

  it("оплаченная невыданная покупка магазина — выдать и вернуть, сначала то, что не стоит денег", () => {
    expect(s.support.actionsFor(shopItem(player, { fulfilledAt: null }))).toEqual(["fulfill", "refund"]);
  });

  it("выданная — только вернуть", () => {
    expect(s.support.actionsFor(shopItem(player))).toEqual(["refund"]);
  });

  it("возврат заказан или звёзды вернулись — ничего", () => {
    expect(s.support.actionsFor(shopItem(player, { fulfilledAt: null, refundReason: "manual", refundRequestedAt: NOW }))).toEqual([]);
    expect(s.support.actionsFor(shopItem(player, { status: "refunded", refundReason: "external", refundedAt: NOW }))).toEqual([]);
  });

  it("неоплаченная — ничего", () => {
    expect(s.support.actionsFor(shopItem(player, { status: "pending", paidAt: null, telegramChargeId: null, fulfilledAt: null }))).toEqual([]);
  });

  it("второй шанс: выдача — сама оплата, повторять нечего — только вернуть", () => {
    const second: StoredPurchase = { ...shopItem(player), product: "continue_run", sku: null, runId: randomUUID(), continueNo: 1, elapsedSec: 125, fulfilledAt: null };

    expect(s.support.actionsFor(second)).toEqual(["refund"]);
  });

  it("у оплаты нет номера площадки — вернуть нельзя; выдать можно", () => {
    expect(s.support.actionsFor(shopItem(player, { telegramChargeId: null, fulfilledAt: null }))).toEqual(["fulfill"]);
    expect(s.support.actionsFor(shopItem(player, { telegramChargeId: null }))).toEqual([]);
  });
});

describe("возврат звёзд поддержкой", () => {
  let s: Setup;
  let admin: AccountRef;
  let target: AccountRef;

  beforeEach(async () => {
    s = setup();
    admin = await person(s, "600001", "admin", "Анна из поддержки");
    target = await person(s, "600002");
  });

  it("заказан возврат с причиной manual, заказ передан в очередь; аудит, сообщение команде и ответ", async () => {
    const purchase = put(s, shopItem(target.accountId));

    const result = await s.support.refund(admin, target.accountId, purchase.purchaseId, NOTE, NOW);

    expect(s.dispatched).toEqual([{ purchaseId: purchase.purchaseId, platform: "telegram", chargeId: purchase.telegramChargeId, payerId: "555000111", reason: "manual" }]);
    expect(s.purchases.rows.get(purchase.purchaseId)).toMatchObject({ refundReason: "manual", refundRequestedAt: NOW, refundedAt: null });
    expect(s.rolesRepository.entries).toHaveLength(1);
    expect(s.rolesRepository.entries[0]).toMatchObject({
      actorAccountId: admin.accountId,
      action: "payments.refund",
      target: target.accountId,
      before: { purchaseId: purchase.purchaseId, fulfilledAt: purchase.fulfilledAt },
      after: { purchaseId: purchase.purchaseId, reason: "manual", chargedStars: 50, note: NOTE },
    });
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({ kind: "refund", actorName: "Анна из поддержки", note: NOTE, at: NOW });
    expect(s.events[0]?.purchase).toMatchObject({ purchaseId: purchase.purchaseId, refundReason: "manual" });
    expect(result.purchase).toMatchObject({ purchaseId: purchase.purchaseId, refundRequestedAt: NOW });
    expect(result.actions).toEqual([]);
  });

  it("звёзды не вернулись до задания очереди: остаток пока не забран", async () => {
    const purchase = put(s, shopItem(target.accountId));

    await s.support.refund(admin, target.accountId, purchase.purchaseId, NOTE, NOW);

    expect(s.api.refunded).toEqual([]);
    expect(s.revoked).toEqual([]);
  });

  it("имени аккаунта нет — в сообщении команде стоит его id", async () => {
    const purchase = put(s, shopItem(target.accountId));
    const stranger: AccountRef = { accountId: randomUUID(), platform: "telegram", platformUserId: OWNER_ID };

    await s.support.refund(stranger, target.accountId, purchase.purchaseId, NOTE, NOW);

    expect(s.events[0]?.actorName).toBe(stranger.accountId);
  });

  it("повторный возврат той же покупки — отказ «Возврат уже заказан — звёзды в пути», второго заказа нет", async () => {
    const purchase = put(s, shopItem(target.accountId));
    await s.support.refund(admin, target.accountId, purchase.purchaseId, NOTE, NOW);

    const second = s.support.refund(admin, target.accountId, purchase.purchaseId, NOTE, NOW);

    await expect(second).rejects.toBeInstanceOf(PurchaseActionUnavailableError);
    await expect(second).rejects.toMatchObject({ code: "purchase_action_unavailable", status: 409, message: "Возврат уже заказан — звёзды в пути" });
    expect(s.dispatched).toHaveLength(1);
    expect(s.rolesRepository.entries).toHaveLength(1);
    expect(s.events).toHaveLength(1);
  });

  it("заказ успели сделать между проверкой и записью — пустой ответ хранилища даёт тот же отказ, ничего не пишется", async () => {
    const purchase = put(s, shopItem(target.accountId));
    vi.spyOn(s.refunds, "manual").mockResolvedValue([]);

    await expect(s.support.refund(admin, target.accountId, purchase.purchaseId, NOTE, NOW)).rejects.toMatchObject({ message: "Возврат уже заказан — звёзды в пути" });

    expect(s.dispatched).toEqual([]);
    expect(s.rolesRepository.entries).toEqual([]);
    expect(s.events).toEqual([]);
  });

  it("между проверкой и записью успел встать возврат другой причины — не наш заказ: отказ, ничего не пишется", async () => {
    const purchase = put(s, shopItem(target.accountId));
    const foreign: RefundOrder = { purchaseId: purchase.purchaseId, platform: "telegram", chargeId: purchase.telegramChargeId ?? "", payerId: "555000111", reason: "unused" };
    vi.spyOn(s.refunds, "manual").mockResolvedValue([foreign]);

    await expect(s.support.refund(admin, target.accountId, purchase.purchaseId, NOTE, NOW)).rejects.toBeInstanceOf(PurchaseActionUnavailableError);

    expect(s.dispatched).toEqual([]);
    expect(s.rolesRepository.entries).toEqual([]);
  });

  it.each([
    ["не оплачена", { status: "pending", paidAt: null, telegramChargeId: null, fulfilledAt: null }, "Покупка не оплачена"],
    ["звёзды уже возвращены", { status: "refunded", refundReason: "external", refundedAt: NOW }, "Звёзды за покупку уже возвращены"],
    ["возврат заказан", { refundReason: "unused", refundRequestedAt: NOW }, "Возврат уже заказан — звёзды в пути"],
    ["у оплаты нет номера площадки", { telegramChargeId: null }, "У оплаты нет номера площадки — вернуть её отсюда нельзя"],
  ] as const)("покупка %s — отказ с понятным текстом", async (_name, patch, message) => {
    const purchase = put(s, shopItem(target.accountId, patch));

    await expect(s.support.refund(admin, target.accountId, purchase.purchaseId, NOTE, NOW)).rejects.toMatchObject({ code: "purchase_action_unavailable", message });

    expect(s.dispatched).toEqual([]);
    expect(s.rolesRepository.entries).toEqual([]);
  });

  it("из нескольких причин называется первая подходящая: не оплачена важнее «уже возвращена»", async () => {
    const purchase = put(s, shopItem(target.accountId, { paidAt: null, refundedAt: NOW, telegramChargeId: null }));

    await expect(s.support.refund(admin, target.accountId, purchase.purchaseId, NOTE, NOW)).rejects.toMatchObject({ message: "Покупка не оплачена" });
  });

  it("чужая покупка (аккаунт не совпадает) и несуществующая — «Покупка не найдена»", async () => {
    const other = await person(s, "600003");
    const purchase = put(s, shopItem(other.accountId));

    await expect(s.support.refund(admin, target.accountId, purchase.purchaseId, NOTE, NOW)).rejects.toBeInstanceOf(PurchaseNotFoundError);
    await expect(s.support.refund(admin, target.accountId, randomUUID(), NOTE, NOW)).rejects.toBeInstanceOf(PurchaseNotFoundError);
    expect(s.dispatched).toEqual([]);
    expect(s.rolesRepository.entries).toEqual([]);
  });

  it("своя покупка при выключенном входе разработчика — отказ с понятным текстом", async () => {
    const own = put(s, shopItem(admin.accountId));

    const attempt = s.support.refund(admin, admin.accountId, own.purchaseId, NOTE, NOW);

    await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
    await expect(attempt).rejects.toMatchObject({ message: "Возвращать звёзды за свою покупку нельзя" });
    expect(s.dispatched).toEqual([]);
  });

  it("своя покупка на машине разработчика — проходит: проверить на себе", async () => {
    const dev = setup({ NODE_ENV: "development", AUTH_DEV_LOGIN: "true" });
    const me = await person(dev, "600004", "admin");
    const own = put(dev, shopItem(me.accountId));

    await dev.support.refund(me, me.accountId, own.purchaseId, NOTE, NOW);

    expect(dev.dispatched).toHaveLength(1);
  });

  it.each([["moderator" as const], ["game_designer" as const]])("роль %s без права payments.support — отказ, хранилище покупок не читается", async (role) => {
    const weak = await person(s, `6100${role.length}`, role);
    const purchase = put(s, shopItem(target.accountId));
    const byId = vi.spyOn(s.purchases, "byId");

    await expect(s.support.refund(weak, target.accountId, purchase.purchaseId, NOTE, NOW)).rejects.toBeInstanceOf(ForbiddenError);

    expect(byId).not.toHaveBeenCalled();
    expect(s.dispatched).toEqual([]);
  });

  it("владелец (из списка окружения) возвращает звёзды", async () => {
    const owner = await person(s, OWNER_ID);
    const purchase = put(s, shopItem(target.accountId));

    await s.support.refund(owner, target.accountId, purchase.purchaseId, NOTE, NOW);

    expect(s.dispatched).toHaveLength(1);
  });
});

describe("повторная выдача покупки", () => {
  let s: Setup;
  let admin: AccountRef;
  let target: AccountRef;

  beforeEach(async () => {
    s = setup();
    admin = await person(s, "620001", "admin", "Анна из поддержки");
    target = await person(s, "620002");
  });

  it("выдача прошла: товар выдан хозяином, покупка отмечена, аудит и сообщение команде", async () => {
    const purchase = put(s, shopItem(target.accountId, { fulfilledAt: null }));

    const result = await s.support.fulfill(admin, target.accountId, purchase.purchaseId, NOTE, NOW);

    expect(s.fulfilled).toEqual([purchase.purchaseId]);
    expect(s.purchases.rows.get(purchase.purchaseId)?.fulfilledAt).toEqual(NOW);
    expect(s.rolesRepository.entries).toHaveLength(1);
    expect(s.rolesRepository.entries[0]).toMatchObject({
      actorAccountId: admin.accountId,
      action: "payments.fulfill",
      target: target.accountId,
      before: { purchaseId: purchase.purchaseId },
      after: { purchaseId: purchase.purchaseId, note: NOTE },
    });
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({ kind: "fulfill", actorName: "Анна из поддержки", note: NOTE, at: NOW });
    expect(result.purchase.fulfilledAt).toEqual(NOW);
    expect(result.actions).toEqual(["refund"]);
  });

  it("дважды не выдаёт: второе нажатие — «Покупка уже выдана», хозяин товара не зовётся", async () => {
    const purchase = put(s, shopItem(target.accountId, { fulfilledAt: null }));
    await s.support.fulfill(admin, target.accountId, purchase.purchaseId, NOTE, NOW);

    const second = s.support.fulfill(admin, target.accountId, purchase.purchaseId, NOTE, NOW);

    await expect(second).rejects.toBeInstanceOf(PurchaseActionUnavailableError);
    await expect(second).rejects.toMatchObject({ message: "Покупка уже выдана" });
    expect(s.fulfilled).toHaveLength(1);
    expect(s.events).toHaveLength(1);
  });

  it("товара нет в каталоге — «Верните звёзды»: покупка не отмечена выданной, аудита и сообщения нет", async () => {
    const purchase = put(s, shopItem(target.accountId, { fulfilledAt: null }));
    s.fulfillment.register("shop_item", async () => {
      throw new UndeliverableError("товара нет в каталоге");
    });

    const attempt = s.support.fulfill(admin, target.accountId, purchase.purchaseId, NOTE, NOW);

    await expect(attempt).rejects.toBeInstanceOf(PurchaseUndeliverableError);
    await expect(attempt).rejects.toMatchObject({ code: "purchase_undeliverable", status: 409 });
    expect(s.purchases.rows.get(purchase.purchaseId)?.fulfilledAt).toBeNull();
    expect(s.rolesRepository.entries).toEqual([]);
    expect(s.events).toEqual([]);
  });

  describe("выдача упала не по сути товара", () => {
    let logged: { event: string; fields: Record<string, unknown> }[];

    beforeEach(() => {
      logged = [];
      vi.spyOn(Logger.prototype, "error").mockImplementation((line: unknown) => {
        const fields = JSON.parse(String(line)) as Record<string, unknown>;
        logged.push({ event: String(fields.event), fields });
      });
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("обычная ошибка — FulfillFailedError, в лог уходят покупка и текст ошибки, отметки о выдаче нет", async () => {
      const purchase = put(s, shopItem(target.accountId, { fulfilledAt: null }));
      s.fulfillment.register("shop_item", async () => {
        throw new Error("кошелёк недоступен");
      });

      const attempt = s.support.fulfill(admin, target.accountId, purchase.purchaseId, NOTE, NOW);

      await expect(attempt).rejects.toBeInstanceOf(FulfillFailedError);
      await expect(attempt).rejects.toMatchObject({ code: "fulfill_failed", status: 503 });
      expect(logged).toEqual([{ event: "purchase_support_fulfill_failed", fields: expect.objectContaining({ purchaseId: purchase.purchaseId, reason: "кошелёк недоступен" }) }]);
      expect(s.purchases.rows.get(purchase.purchaseId)?.fulfilledAt).toBeNull();
      expect(s.rolesRepository.entries).toEqual([]);
      expect(s.events).toEqual([]);
    });

    it("выдача висит дольше десяти секунд — FulfillFailedError: поддержка не ждёт вечно", async () => {
      vi.useFakeTimers();
      const purchase = put(s, shopItem(target.accountId, { fulfilledAt: null }));
      s.fulfillment.register("shop_item", () => new Promise<void>(() => undefined));

      const attempt = expect(s.support.fulfill(admin, target.accountId, purchase.purchaseId, NOTE, NOW)).rejects.toBeInstanceOf(FulfillFailedError);
      await vi.advanceTimersByTimeAsync(10_000);

      await attempt;
      expect(s.purchases.rows.get(purchase.purchaseId)?.fulfilledAt).toBeNull();
    });
  });

  it("уже выдана — отказ «Покупка уже выдана»; у товара без выдачи — про второй шанс; возврат заказан — «Возврат уже заказан»", async () => {
    const issued = put(s, shopItem(target.accountId));
    const second = put(s, { ...shopItem(target.accountId, { fulfilledAt: null }), product: "continue_run", sku: null, runId: randomUUID(), continueNo: 1, elapsedSec: 90 });
    const ordered = put(s, shopItem(target.accountId, { fulfilledAt: null, refundReason: "manual", refundRequestedAt: NOW }));

    await expect(s.support.fulfill(admin, target.accountId, issued.purchaseId, NOTE, NOW)).rejects.toMatchObject({ message: "Покупка уже выдана" });
    await expect(s.support.fulfill(admin, target.accountId, second.purchaseId, NOTE, NOW)).rejects.toMatchObject({
      message: "У этого товара нет выдачи: второй шанс засчитывается в забеге",
    });
    await expect(s.support.fulfill(admin, target.accountId, ordered.purchaseId, NOTE, NOW)).rejects.toMatchObject({ message: "Возврат уже заказан — звёзды в пути" });
    expect(s.fulfilled).toEqual([]);
  });

  it("чужая покупка — «Покупка не найдена»; своя — отказ с текстом про выдачу", async () => {
    const other = await person(s, "620003");
    const foreign = put(s, shopItem(other.accountId, { fulfilledAt: null }));
    const own = put(s, shopItem(admin.accountId, { fulfilledAt: null }));

    await expect(s.support.fulfill(admin, target.accountId, foreign.purchaseId, NOTE, NOW)).rejects.toBeInstanceOf(PurchaseNotFoundError);
    const attempt = s.support.fulfill(admin, admin.accountId, own.purchaseId, NOTE, NOW);
    await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
    await expect(attempt).rejects.toMatchObject({ message: "Выдавать свою покупку нельзя" });
    expect(s.fulfilled).toEqual([]);
  });

  it("на машине разработчика свою покупку выдать можно", async () => {
    const dev = setup({ NODE_ENV: "development", AUTH_DEV_LOGIN: "true" });
    const me = await person(dev, "620004", "admin");
    const own = put(dev, shopItem(me.accountId, { fulfilledAt: null }));

    await dev.support.fulfill(me, me.accountId, own.purchaseId, NOTE, NOW);

    expect(dev.fulfilled).toEqual([own.purchaseId]);
  });

  it("без права payments.support — отказ, хозяин товара не зовётся", async () => {
    const moderator = await person(s, "620005", "moderator");
    const purchase = put(s, shopItem(target.accountId, { fulfilledAt: null }));

    await expect(s.support.fulfill(moderator, target.accountId, purchase.purchaseId, NOTE, NOW)).rejects.toBeInstanceOf(ForbiddenError);

    expect(s.fulfilled).toEqual([]);
  });
});

describe("задание возврата забирает остаток после того, как звёзды ушли", () => {
  let s: Setup;
  let target: AccountRef;
  let logged: { level: string; event: string; fields: Record<string, unknown> }[];

  beforeEach(async () => {
    s = setup();
    target = await person(s, "630001");
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

  /** Заказанный возврат — как его поднимает очередь после перезапуска: из хранилища, а не из памяти. */
  async function ordered(reason: "manual" | "unused"): Promise<{ purchase: StoredPurchase; order: RefundOrder }> {
    const purchase = put(s, shopItem(target.accountId, { telegramChargeId: "charge-job-1", refundReason: reason, refundRequestedAt: NOW }));
    const [order] = await s.refunds.pending(10);
    if (order === undefined) throw new Error("возврат не заказан");
    return { purchase, order };
  }

  it("причина manual: звёзды возвращены, затем отзыв вызван один раз; в логе refund_done — что забрано", async () => {
    const { purchase, order } = await ordered("manual");

    await s.refunds.refund(order, NOW.getTime());

    expect(s.api.refunded).toEqual([{ userId: 555000111, chargeId: "charge-job-1" }]);
    expect(s.purchases.rows.get(purchase.purchaseId)).toMatchObject({ status: "refunded", refundReason: "manual", refundedAt: NOW });
    expect(s.revoked).toEqual([{ purchaseId: purchase.purchaseId, at: NOW }]);
    const done = logged.find((entry) => entry.event === "refund_done");
    expect(done?.fields).toMatchObject({ purchaseId: purchase.purchaseId, reason: "manual", revoked: ["самоцветы: 120 из 150"] });
  });

  it("звёзды не ушли (Telegram отказал окончательно) — остаток не забирается: игрок не остаётся ни без звёзд, ни без товара", async () => {
    const { order } = await ordered("manual");
    s.api.refundFailWith = new TelegramApiError("refundStarPayment", 400, "Bad Request: PAYMENT_NOT_FOUND", null);

    await expect(s.refunds.refund(order, NOW.getTime())).rejects.toThrow();

    expect(s.revoked).toEqual([]);
  });

  it("другая причина (unused): отзыв не вызван, в логе нет поля revoked", async () => {
    const { order } = await ordered("unused");

    await s.refunds.refund(order, NOW.getTime());

    expect(s.revoked).toEqual([]);
    const done = logged.find((entry) => entry.event === "refund_done");
    expect(done).toBeDefined();
    expect(done?.fields).not.toHaveProperty("revoked");
  });

  it("повтор задания manual (Telegram отвечает «уже возвращено») — отзыв вызван снова, и в тот же момент: доделывает, если первый раз упал", async () => {
    const { purchase, order } = await ordered("manual");
    await s.refunds.refund(order, NOW.getTime());
    s.api.refundFailWith = new TelegramApiError("refundStarPayment", 400, "Bad Request: CHARGE_ALREADY_REFUNDED", null);

    await s.refunds.refund(order, NOW.getTime() + 60_000);

    expect(s.revoked).toEqual([
      { purchaseId: purchase.purchaseId, at: NOW },
      { purchaseId: purchase.purchaseId, at: NOW },
    ]);
  });

  it("отзыв бросил — задание бросает, а возврат записан: повтор доведёт отзыв до конца", async () => {
    const { purchase, order } = await ordered("manual");
    const failing = new PurchaseRevocation();
    let down = true;
    failing.register("shop_item", async (bought, at) => {
      if (down) throw new Error("кошелёк недоступен");
      s.revoked.push({ purchaseId: bought.purchaseId, at });
      return { lines: ["самоцветы: 120 из 150"] };
    });
    const refunds = new PaymentRefunds(s.purchases, starsProviders(s.api), failing);

    await expect(refunds.refund(order, NOW.getTime())).rejects.toThrow("кошелёк недоступен");
    expect(s.purchases.rows.get(purchase.purchaseId)).toMatchObject({ status: "refunded", refundedAt: NOW });
    expect(s.revoked).toEqual([]);

    down = false;
    s.api.refundFailWith = new TelegramApiError("refundStarPayment", 400, "Bad Request: CHARGE_ALREADY_REFUNDED", null);
    await refunds.refund(order, NOW.getTime() + 60_000);

    expect(s.revoked).toEqual([{ purchaseId: purchase.purchaseId, at: NOW }]);
  });

  it("цепочка целиком: поддержка заказывает, очередь возвращает звёзды, остаток забран, покупки аккаунту не закрыты", async () => {
    const admin = await person(s, "630002", "admin");
    const purchase = put(s, shopItem(target.accountId, { telegramChargeId: "charge-chain-1" }));

    await s.support.refund(admin, target.accountId, purchase.purchaseId, NOTE, NOW);
    for (const order of s.dispatched) await s.refunds.refund(order, NOW.getTime() + 1000);

    expect(s.purchases.rows.get(purchase.purchaseId)).toMatchObject({ status: "refunded", refundReason: "manual" });
    expect(s.revoked).toHaveLength(1);
    // Ручной возврат — наше решение: пометка внешнего возврата (она закрывает покупки, T-0024) не ставится.
    expect(await s.purchases.refundStats(target.accountId)).toEqual({ paid: 1, refunded: 0 });
  });
});
