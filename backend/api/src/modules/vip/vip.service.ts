import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { methodFor, priceIn } from "../payments/payment-methods.js";
import { PaymentsUnsupportedError } from "../payments/payments-errors.js";
import { PaymentsHooks, type SubscriptionChange } from "../payments/payments-hooks.js";
import { PaymentsService, type ShopInvoice } from "../payments/payments.service.js";
import { PurchaseFulfillment } from "../payments/purchase-fulfillment.js";
import type { StoredPurchase } from "../payments/purchase-types.js";
import { SubscriptionRenewal } from "../payments/subscription-renewal.js";
import type { AccountRef } from "../roles/roles.service.js";
import { WalletService } from "../wallet/wallet.service.js";
import { VipActiveError, VipInactiveError, VipResumeUnavailableError } from "./vip-errors.js";
import { VIP_DAILY_GEMS, VIP_PERIOD_SEC, VIP_PLAN, vipProduct } from "./vip-plan.js";
import { VIP_REPOSITORY, type VipCanceller, type VipRenewal, type VipRepository, type VipState, type VipSubscriptionRow } from "./vip.repository.js";

/**
 * VIP — подписка площадки (docs/35-stage4-plan.md §3.6, Р20, Р26, Р44; WP10).
 * Площадка списывает каждый период сама; каждая оплата — период в журнале,
 * и VIP идёт до самого позднего конца периода. Отменённое продление не
 * отнимает оплаченного: VIP работает до конца периода.
 *
 * Оплату ведёт модуль оплаты — счёт с периодом, продления, отмена
 * продления через порт площадки; VIP решает, почём он и что даёт. Сейчас —
 * самоцветы раз в игровые сутки; без рекламы и увеличенные награды — там,
 * где их выдают (Р44).
 */

const DB_TIMEOUT_MS = 3_000;

export interface VipView {
  active: boolean;
  /** конец VIP; `null` — VIP не было */
  until: Date | null;
  /** продление: `on` — площадка спишет следующий период; `null` — подписок не было */
  renewal: VipRenewal | null;
  /** отменённое нами продление ещё можно вернуть: оплаченный период идёт */
  canResume: boolean;
  /** можно оформить: VIP не идёт или не продлевается */
  canOrder: boolean;
  /** цена периода в звёздах; `null` — на этой площадке способа оплаты нет */
  stars: number | null;
  periodDays: number;
  daily: { gems: number; claimed: boolean };
}

export interface VipDailyResult {
  claimed: boolean;
  /** сколько легло на счёт: меньше обещанного — упёрлись в суточный потолок кошелька */
  gems: number;
  view: VipView;
}

@Injectable()
export class VipService implements OnModuleInit {
  private readonly logger = new Logger("vip");

  constructor(
    @Inject(VIP_REPOSITORY) private readonly repository: VipRepository,
    private readonly payments: PaymentsService,
    private readonly fulfillment: PurchaseFulfillment,
    private readonly hooks: PaymentsHooks,
    private readonly renewal: SubscriptionRenewal,
    private readonly wallet: WalletService,
  ) {}

  onModuleInit(): void {
    this.fulfillment.register("vip", (purchase) => this.fulfill(purchase));
    this.hooks.onSubscriptionChanged("vip", (change) => this.changed(change));
  }

  async view(account: AccountRef, at = new Date()): Promise<VipView> {
    return viewOf(await this.state(account.accountId, at), account, at);
  }

  async order(account: AccountRef, at = new Date()): Promise<ShopInvoice> {
    const view = await this.view(account, at);
    if (!view.canOrder) throw new VipActiveError();
    if (view.stars === null) throw new PaymentsUnsupportedError();
    const invoice = await this.payments.shopInvoice(
      account,
      {
        product: "vip",
        sku: VIP_PLAN.sku,
        priceStars: view.stars,
        once: false,
        subscriptionPeriodSec: VIP_PERIOD_SEC,
        text: { title: VIP_PLAN.title, description: VIP_PLAN.description },
      },
      at.getTime(),
    );
    this.log("vip_order", { accountId: account.accountId, purchaseId: invoice.purchaseId, status: invoice.status });
    return invoice;
  }

  /**
   * Отменить продление — всех продлеваемых подписок аккаунта: их бывает две,
   * если игрок оплатил два счёта. Площадка отказала — продления там уже нет
   * (отменил сам игрок или подписка кончилась), и вернуть его можем не мы.
   */
  async cancel(account: AccountRef, at = new Date()): Promise<VipView> {
    const state = await this.state(account.accountId, at);
    for (const subscription of state.subscriptions.filter((item) => item.renewal === "on")) {
      const result = await this.renewal.set(account, subscription.subscriptionId, false);
      const by: VipCanceller = result === "done" ? "game" : "player";
      await withTimeout(this.repository.setRenewal(subscription.subscriptionId, "cancelled", by, at), DB_TIMEOUT_MS, "продление VIP");
      this.log("subscription_cancelled", { accountId: account.accountId, subscriptionId: subscription.subscriptionId, by, platform: result });
    }
    return await this.view(account, at);
  }

  /** Вернуть продление, отменённое нашей кнопкой, пока оплаченный период идёт. */
  async resume(account: AccountRef, at = new Date()): Promise<VipView> {
    const state = await this.state(account.accountId, at);
    const resumable = state.subscriptions.filter((item) => isResumable(item, at));
    if (resumable.length === 0 || state.subscriptions.some((item) => item.renewal === "on")) throw new VipResumeUnavailableError();
    let resumed = false;
    for (const subscription of resumable) {
      if ((await this.renewal.set(account, subscription.subscriptionId, true)) !== "done") continue;
      await withTimeout(this.repository.setRenewal(subscription.subscriptionId, "on", null, at), DB_TIMEOUT_MS, "продление VIP");
      this.log("subscription_resumed", { accountId: account.accountId, subscriptionId: subscription.subscriptionId });
      resumed = true;
      // Вернуть одной подписки хватит: вторая продлевала бы тот же VIP за вторые деньги.
      break;
    }
    if (!resumed) throw new VipResumeUnavailableError();
    return await this.view(account, at);
  }

  /**
   * Самоцветы дня (Р26): раз в игровые сутки, пока VIP идёт. Начисление
   * ключом суток, потом отметка: два запроса разом начислят однажды, а
   * начисленное, но не отмеченное после сбоя кошелёк узнает по ключу.
   */
  async claimDaily(account: AccountRef, at = new Date()): Promise<VipDailyResult> {
    const state = await this.state(account.accountId, at);
    if (!isActive(state, at)) throw new VipInactiveError();
    if (state.dailyClaimedToday) return { claimed: false, gems: 0, view: viewOf(state, account, at) };

    const grant = await this.wallet.grant({
      accountId: account.accountId,
      resource: "gems",
      amount: VIP_DAILY_GEMS,
      reason: "subscription_daily",
      source: "vip_daily",
      idempotencyKey: `vip_daily:${account.accountId}:${state.today}`,
      at,
    });
    const claimed = await withTimeout(this.repository.claimDaily(account.accountId, state.today, at), DB_TIMEOUT_MS, "самоцветы VIP");
    if (claimed) this.log("vip_daily_claimed", { accountId: account.accountId, day: state.today, gems: grant.credited });
    return { claimed, gems: claimed ? grant.credited : 0, view: viewOf({ ...state, dailyClaimedToday: true }, account, at) };
  }

  /** Оплаченный период — в журнал. Повтор выдачи ничего не продлевает: период один на оплату. */
  async fulfill(purchase: StoredPurchase): Promise<void> {
    if (purchase.paidAt === null) throw new Error(`покупка ${purchase.purchaseId} не оплачена — период не выдаётся`);
    const subscriptionId = purchase.renewalOf ?? purchase.purchaseId;
    const period = await withTimeout(
      this.repository.addPeriod({ purchaseId: purchase.purchaseId, subscriptionId, accountId: purchase.accountId, paidAt: purchase.paidAt, periodSec: VIP_PERIOD_SEC, at: new Date() }),
      DB_TIMEOUT_MS,
      "период VIP",
    );
    if (!period.created) return;
    this.log(purchase.renewalOf === null ? "subscription_started" : "subscription_renewed", {
      accountId: purchase.accountId,
      subscriptionId,
      purchaseId: purchase.purchaseId,
      mode: purchase.mode,
      until: period.endsAt.toISOString(),
    });
  }

  /** Игрок отменил или вернул продление на площадке, или площадка не смогла списать период. */
  private async changed(change: SubscriptionChange): Promise<void> {
    if (change.subscription.product !== "vip") return;
    const [renewal, by] = RENEWAL_OF[change.state];
    const subscriptionId = change.subscription.purchaseId;
    const result = await withTimeout(this.repository.setRenewal(subscriptionId, renewal, by, change.at), DB_TIMEOUT_MS, "продление VIP");
    if (result === "missing") {
      // Подписка без выдачи — первая оплата ещё в очереди. Состояние потом
      // придёт от площадки заново или его поправит оплата следующего периода.
      this.logger.warn(JSON.stringify({ module: "vip", event: "renewal_unmatched", subscriptionId, state: change.state }));
      return;
    }
    const event = change.state === "cancelled" ? "subscription_cancelled" : change.state === "failed" ? "subscription_failed" : "subscription_resumed";
    this.log(event, { accountId: change.subscription.accountId, subscriptionId, by: "platform", changed: result === "updated" });
  }

  private async state(accountId: string, at: Date): Promise<VipState> {
    return await withTimeout(this.repository.state(accountId, at), DB_TIMEOUT_MS, "VIP");
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ module: "vip", event, ...fields }));
  }
}

const RENEWAL_OF: Record<SubscriptionChange["state"], [VipRenewal, VipCanceller | null]> = {
  cancelled: ["cancelled", "player"],
  active: ["on", null],
  failed: ["failed", null],
};

function isActive(state: Pick<VipState, "until">, at: Date): boolean {
  return state.until !== null && state.until.getTime() > at.getTime();
}

/** Вернуть продление можем только отменённое нами и пока оплаченный период подписки идёт. */
function isResumable(subscription: VipSubscriptionRow, at: Date): boolean {
  return subscription.renewal === "cancelled" && subscription.cancelledBy === "game" && subscription.until !== null && subscription.until.getTime() > at.getTime();
}

export function viewOf(state: VipState, account: AccountRef, at: Date): VipView {
  const active = isActive(state, at);
  const renewing = state.subscriptions.some((item) => item.renewal === "on");
  const method = methodFor(account.platform);
  return {
    active,
    until: state.until,
    renewal: renewing ? "on" : (state.subscriptions[0]?.renewal ?? null),
    canResume: active && !renewing && state.subscriptions.some((item) => isResumable(item, at)),
    canOrder: !(active && renewing),
    stars: method === undefined ? null : priceIn(vipProduct(), method),
    periodDays: VIP_PLAN.periodDays,
    daily: { gems: VIP_DAILY_GEMS, claimed: state.dailyClaimedToday },
  };
}
