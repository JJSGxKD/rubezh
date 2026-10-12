import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { methodFor, priceIn } from "../payments/payment-methods.js";
import { PaymentsUnsupportedError } from "../payments/payments-errors.js";
import { PaymentsHooks, type SubscriptionChange } from "../payments/payments-hooks.js";
import { PaymentsService, type ShopInvoice } from "../payments/payments.service.js";
import { PurchaseFulfillment } from "../payments/purchase-fulfillment.js";
import { PurchaseRevocation, type Revocation } from "../payments/purchase-revocation.js";
import type { PaymentMode, StoredPurchase } from "../payments/purchase-types.js";
import { SubscriptionRenewal } from "../payments/subscription-renewal.js";
import { AdPasses } from "../ads/ads-passes.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { AccountRestrictions } from "../restrictions/account-restrictions.js";
import type { AccountRef } from "../roles/roles.service.js";
import { WalletBonuses } from "../wallet/wallet-bonus.js";
import type { GrantReason } from "../wallet/wallet-types.js";
import { WalletService } from "../wallet/wallet.service.js";
import { VipActiveError, VipInactiveError, VipResumeUnavailableError } from "./vip-errors.js";
import { VIP_DAILY_GEMS, VIP_PERIOD_SEC, VIP_PLAN, VIP_REWARD_MUL, vipProduct, vipRewardMul } from "./vip-plan.js";
import { VIP_REPOSITORY, type VipCanceller, type VipRenewal, type VipRepository, type VipState, type VipSubscriptionRow } from "./vip.repository.js";

/**
 * VIP — подписка площадки (docs/35-stage4-plan.md §3.6, Р20, Р26, Р44; WP10).
 * Площадка списывает каждый период сама; каждая оплата — период в журнале,
 * и VIP идёт до самого позднего конца периода. Отменённое продление не
 * отнимает оплаченного: VIP работает до конца периода.
 *
 * Оплату ведёт модуль оплаты — счёт с периодом, продления, отмена
 * продления через порт площадки; VIP решает, почём он и что даёт: самоцветы
 * раз в игровые сутки, увеличенные награды — надбавкой в начислении
 * кошелька (Р44) — и рекламу без ролика: пропуском в модуле рекламы, который
 * выдаёт награду места сразу и не показывает межстраничную (§3.6).
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
  /** сколько спишется на самом деле: в тестовом режиме — звезда (Р14) */
  chargedStars: number | null;
  mode: PaymentMode;
  /** товар в покупке и событиях */
  sku: string;
  periodDays: number;
  daily: { gems: number; claimed: boolean };
  /** во сколько раз больше награды дня, колеса, забега и заданий, пока VIP идёт */
  rewardMul: number;
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
    private readonly bonuses: WalletBonuses,
    private readonly adPasses: AdPasses,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: Pick<AccountRepository, "byId">,
    // Реестр нужен модулю, а не каждому тесту VIP: без него отзыв регистрируется в своём, пустом.
    private readonly revocation: PurchaseRevocation = new PurchaseRevocation(),
    private readonly restrictions: AccountRestrictions,
  ) {}

  onModuleInit(): void {
    this.fulfillment.register("vip", (purchase) => this.fulfill(purchase));
    this.revocation.register("vip", (purchase, at) => this.revoke(purchase, at));
    this.hooks.onSubscriptionChanged("vip", (change) => this.changed(change));
    this.bonuses.register("vip", (accountId, reason, at) => this.rewardMul(accountId, reason, at));
    this.adPasses.register("vip", (accountId, at) => this.activeAt(accountId, at));
  }

  /**
   * Надбавка к начислению (Р44): только причинам из `VIP_REWARD_MUL` и только
   * пока VIP идёт. Причине без надбавки база не нужна — её начисление не
   * платит за VIP лишним запросом.
   */
  async rewardMul(accountId: string, reason: GrantReason, at: Date): Promise<number> {
    const mul = vipRewardMul(reason);
    if (mul === undefined) return 1;
    return (await this.activeAt(accountId, at)) ? mul : 1;
  }

  /** Идёт ли VIP в момент `at` — один запрос по индексу журнала периодов. */
  async activeAt(accountId: string, at: Date): Promise<boolean> {
    const until = await withTimeout(this.repository.until(accountId), DB_TIMEOUT_MS, "VIP");
    return until !== null && until.getTime() > at.getTime();
  }

  async view(account: AccountRef, at = new Date()): Promise<VipView> {
    return viewOf(await this.state(account.accountId, at), account, at, this.payments);
  }

  async order(account: AccountRef, at = new Date()): Promise<ShopInvoice> {
    // Закрытые покупки (T-0024) отвечают раньше всего остального.
    await this.restrictions.ensure(account.accountId, "purchases", at);
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
    if (state.dailyClaimedToday) return { claimed: false, gems: 0, view: viewOf(state, account, at, this.payments) };

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
    return { claimed, gems: claimed ? grant.credited : 0, view: viewOf({ ...state, dailyClaimedToday: true }, account, at, this.payments) };
  }

  /** Оплаченный период — в журнал. Повтор выдачи ничего не продлевает: период один на оплату. */
  async fulfill(purchase: StoredPurchase): Promise<void> {
    if (purchase.paidAt === null) throw new Error(`покупка ${purchase.purchaseId} не оплачена — период не выдаётся`);
    const subscriptionId = purchase.renewalOf ?? purchase.purchaseId;
    const now = new Date();
    const period = await withTimeout(
      this.repository.addPeriod({ purchaseId: purchase.purchaseId, subscriptionId, accountId: purchase.accountId, paidAt: purchase.paidAt, periodSec: VIP_PERIOD_SEC, at: now }),
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
    // Продление действующей подписки — не вторая подписка.
    if (purchase.renewalOf === null) await this.stopSecondSubscription(purchase, now);
  }

  /**
   * Две оплаты проскочили предварительную проверку почти одновременно: проверка
   * второй прошла раньше, чем записана первая. Оплаченный период второй
   * остаётся у игрока и встал за первым — он заплатил, отнимать нечего, — а
   * продление второй выключается, чтобы в следующем месяце не было второго
   * списания. Возврат лишней оплаты здесь не делается (T-0023, T-0024).
   *
   * Не бросает: период уже записан, а повтор задания его не повторит
   * (`created === false`), так что бросок ничего бы не вернул.
   */
  private async stopSecondSubscription(purchase: StoredPurchase, now: Date): Promise<void> {
    const fields = { accountId: purchase.accountId, stopped: purchase.purchaseId };
    try {
      const state = await this.state(purchase.accountId, now);
      const kept = state.subscriptions.find((item) => item.renewal === "on" && item.subscriptionId !== purchase.purchaseId);
      if (kept === undefined) return;

      const account = await withTimeout(this.accounts.byId(purchase.accountId), DB_TIMEOUT_MS, "аккаунт подписчика");
      if (account === null) {
        this.logError("vip_subscription_twice_stop_failed", { ...fields, kept: kept.subscriptionId, reason: "аккаунт не найден" });
        return;
      }
      const ref: AccountRef = { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
      const result = await this.renewal.set(ref, purchase.purchaseId, false);
      // Площадка отказала — продления там уже нет (его отменил сам игрок): как в `cancel`.
      const by: VipCanceller = result === "done" ? "game" : "player";
      await withTimeout(this.repository.setRenewal(purchase.purchaseId, "cancelled", by, now), DB_TIMEOUT_MS, "продление VIP");
      this.logError("vip_subscription_twice", { ...fields, kept: kept.subscriptionId });
    } catch (error: unknown) {
      this.logError("vip_subscription_twice_stop_failed", { ...fields, reason: error instanceof Error ? error.message : "unknown" });
    }
  }

  /**
   * Отзыв остатка при внешнем возврате звёзд (tasks/T-0023): неиспользованная
   * часть оплаченного периода убирается, следующие периоды цепочки сдвигаются
   * на убранное, продление подписки выключается. Идемпотентно: обработка
   * возврата повторяется, пока не пройдёт целиком, и повтор уже обрезанный
   * период не режет второй раз.
   *
   * Сначала срок, потом продление: не обрезался период — бросок, и повтор
   * начнёт с того же места. Ошибку площадки отзыв не пробивает: продления там
   * уже может не быть, а срок обрезан.
   */
  async revoke(purchase: StoredPurchase, at: Date): Promise<Revocation> {
    if (this.repository.cutPeriod === undefined) throw new Error("хранилище VIP не умеет обрезать период");
    const cut = await withTimeout(this.repository.cutPeriod(purchase.purchaseId, at), DB_TIMEOUT_MS, "возврат VIP");
    if (cut === null) return { lines: ["VIP: периода нет"] };

    await this.stopRenewal(purchase.accountId, cut.subscriptionId, at);

    const lines: string[] = [];
    if (cut.removedSec === 0) lines.push("VIP: период уже использован");
    else if (cut.until !== null && cut.until.getTime() > at.getTime()) lines.push(`VIP: убрано ${hoursOf(cut.removedSec)} ч, теперь до ${utcMinute(cut.until)}`);
    else lines.push(`VIP: убрано ${hoursOf(cut.removedSec)} ч, VIP закончился`);
    lines.push("продление выключено");
    return { lines };
  }

  private async stopRenewal(accountId: string, subscriptionId: string, at: Date): Promise<void> {
    // Ошибка базы здесь — не ошибка площадки: пусть бросается, обработка возврата повторится
    // (обрезанный период второй раз ничего не отнимет) и выключит продление на площадке.
    const account = await withTimeout(this.accounts.byId(accountId), DB_TIMEOUT_MS, "аккаунт подписчика");
    if (account === null) {
      this.warnRenewal(accountId, subscriptionId, "аккаунт не найден");
    } else {
      try {
        // Отказ площадки (`rejected`) — продления там уже нет, игрок отменил его сам: идём дальше.
        await this.renewal.set({ accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId }, subscriptionId, false);
      } catch (error: unknown) {
        this.warnRenewal(accountId, subscriptionId, error instanceof Error ? error.message : "unknown");
      }
    }
    await withTimeout(this.repository.setRenewal(subscriptionId, "cancelled", "game", at), DB_TIMEOUT_MS, "продление VIP");
    this.log("subscription_cancelled", { accountId, subscriptionId, by: "game", cause: "refund" });
  }

  private warnRenewal(accountId: string, subscriptionId: string, reason: string): void {
    this.logger.warn(JSON.stringify({ module: "vip", event: "vip_revoke_renewal_failed", accountId, subscriptionId, reason }));
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

  private logError(event: string, fields: Record<string, unknown>): void {
    this.logger.error(JSON.stringify({ module: "vip", event, ...fields }));
  }
}

const RENEWAL_OF: Record<SubscriptionChange["state"], [VipRenewal, VipCanceller | null]> = {
  cancelled: ["cancelled", "player"],
  active: ["on", null],
  failed: ["failed", null],
};

/** Часы убранного: целые — без дроби, иначе с десятой («0.5»). */
function hoursOf(seconds: number): string {
  const hours = seconds / 3600;
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

/** ГГГГ-ММ-ДД ЧЧ:ММ по UTC: сервер и логи в UTC, команда сверяет по ним. */
function utcMinute(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

function isActive(state: Pick<VipState, "until">, at: Date): boolean {
  return state.until !== null && state.until.getTime() > at.getTime();
}

/** Вернуть продление можем только отменённое нами и пока оплаченный период подписки идёт. */
function isResumable(subscription: VipSubscriptionRow, at: Date): boolean {
  return subscription.renewal === "cancelled" && subscription.cancelledBy === "game" && subscription.until !== null && subscription.until.getTime() > at.getTime();
}

/** Режим оплаты и сколько спишется за цену — правило модуля оплаты. */
type Pricing = Pick<PaymentsService, "mode" | "charge">;

export function viewOf(state: VipState, account: AccountRef, at: Date, pricing: Pricing): VipView {
  const active = isActive(state, at);
  const renewing = state.subscriptions.some((item) => item.renewal === "on");
  const method = methodFor(account.platform);
  const stars = method === undefined ? null : priceIn(vipProduct(), method);
  return {
    active,
    until: state.until,
    renewal: renewing ? "on" : (state.subscriptions[0]?.renewal ?? null),
    canResume: active && !renewing && state.subscriptions.some((item) => isResumable(item, at)),
    canOrder: !(active && renewing),
    stars,
    chargedStars: stars === null ? null : pricing.charge(stars).chargedStars,
    mode: pricing.mode,
    sku: VIP_PLAN.sku,
    periodDays: VIP_PLAN.periodDays,
    daily: { gems: VIP_DAILY_GEMS, claimed: state.dailyClaimedToday },
    rewardMul: VIP_REWARD_MUL.run_reward ?? 1,
  };
}
