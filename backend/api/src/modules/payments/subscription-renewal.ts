import { Inject, Injectable, Logger } from "@nestjs/common";
import { PaymentProviderRejectedError, PaymentProviders, PaymentProviderUnavailableError } from "../../platforms/ports/payment-provider.js";
import type { AccountRef } from "../roles/roles.service.js";
import { PaymentsUnavailableError, PaymentsUnsupportedError, PurchaseNotFoundError } from "./payments-errors.js";
import { isGranted, SUBSCRIPTION_PRODUCTS } from "./purchase-types.js";
import { PURCHASES_REPOSITORY, type PurchasesRepository } from "./purchases.repository.js";

/**
 * Продление подписки по нашей кнопке (docs/35-stage4-plan.md §3.6, Р20):
 * отменить его или вернуть отменённое нами. Площадку просим через порт
 * оплаты — первой оплатой подписки: по ней площадка её и знает.
 *
 * Отменённое игроком на площадке мы вернуть не можем — только сам игрок там
 * же; площадка ответит отказом, и это `rejected`, а не ошибка.
 */
@Injectable()
export class SubscriptionRenewal {
  private readonly logger = new Logger("payments");

  constructor(
    @Inject(PURCHASES_REPOSITORY) private readonly purchases: Pick<PurchasesRepository, "byId">,
    private readonly providers: PaymentProviders,
  ) {}

  /** @param subscriptionId первая покупка подписки */
  async set(account: AccountRef, subscriptionId: string, renew: boolean): Promise<"done" | "rejected"> {
    const first = await this.purchases.byId(subscriptionId);
    // Чужая подписка неотличима от несуществующей — как чужая покупка.
    if (first === null || first.accountId !== account.accountId || !SUBSCRIPTION_PRODUCTS.includes(first.product) || first.renewalOf !== null) {
      throw new PurchaseNotFoundError();
    }
    if (!isGranted(first) || first.telegramChargeId === null) throw new PurchaseNotFoundError();
    const provider = this.providers.for(account.platform);
    if (provider === null || provider.subscriptionPeriodSec === null) throw new PaymentsUnsupportedError();

    const fields = { accountId: account.accountId, purchaseId: subscriptionId, renew };
    try {
      await provider.setSubscriptionRenewal(account.platformUserId, first.telegramChargeId, renew);
    } catch (error: unknown) {
      if (error instanceof PaymentProviderRejectedError) {
        this.log("warn", "subscription_renewal_rejected", { ...fields, reason: error.message });
        return "rejected";
      }
      if (error instanceof PaymentProviderUnavailableError) {
        this.log("warn", "subscription_renewal_failed", { ...fields, reason: error.message });
        throw new PaymentsUnavailableError();
      }
      throw error;
    }
    this.log("log", "subscription_renewal_set", fields);
    return "done";
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "payments", event, ...fields }));
  }
}
