import { Inject, Injectable, Logger } from "@nestjs/common";
import { ValidationError } from "../../common/domain-error.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { InsufficientFundsError } from "../wallet/wallet-errors.js";
import { InsufficientBalance } from "../wallet/wallet-ledger.js";
import { WalletService } from "../wallet/wallet.service.js";
import { BOOST_PRICES, MAX_BOOSTS_PER_RUN, priceOf, type BoostPrice } from "./boost-catalog.js";
import { BoostRunStartedError } from "./boosts-errors.js";
import { BOOSTS_REPOSITORY, type BoostCost, type BoostsRepository } from "./boosts.repository.js";

/**
 * Бусты на забег (docs/35-stage4-plan.md §3.5, Р39, Р17): каталог с ценами,
 * покупка до старта, возврат забегу, который так и не начался, и сверка
 * заявленных в итоге бустов с покупками.
 */

export interface BoostCatalogView {
  boosts: ({ id: string } & BoostPrice)[];
  maxPerRun: number;
}

export interface ActivationView {
  runId: string;
  boosts: string[];
  cost: BoostCost;
}

@Injectable()
export class BoostsService {
  private readonly logger = new Logger("boosts");

  constructor(
    @Inject(BOOSTS_REPOSITORY) private readonly repository: BoostsRepository,
    private readonly wallet: WalletService,
    private readonly notifications: NotificationsService,
  ) {}

  catalog(): BoostCatalogView {
    return { boosts: Object.entries(BOOST_PRICES).map(([id, price]) => ({ id, ...price })), maxPerRun: MAX_BOOSTS_PER_RUN };
  }

  /**
   * Купить бусты на забег. Повтор с тем же забегом — тот же ответ без
   * списания: игрок, у которого оборвалась связь на «В бой», нажмёт ещё раз.
   * Повтор с другим набором — тоже прежний набор: на забег покупка одна.
   */
  async activate(accountId: string, runId: string, boosts: readonly string[], at = new Date()): Promise<ActivationView> {
    if (boosts.length === 0 || boosts.length > MAX_BOOSTS_PER_RUN || new Set(boosts).size !== boosts.length) {
      throw new ValidationError(`На забег — от одного до ${MAX_BOOSTS_PER_RUN} разных бустов`);
    }
    const cost = priceOf(boosts);
    if (cost === null) throw new ValidationError("Такого буста нет");

    let outcome;
    try {
      outcome = await this.repository.activate({ accountId, runId, boosts, cost, at });
    } catch (error: unknown) {
      if (!(error instanceof InsufficientBalance)) throw error;
      const balance = (await this.wallet.balances(accountId))[error.resource];
      throw new InsufficientFundsError(error.resource, error.needed, balance);
    }
    if (outcome.status === "started") throw new BoostRunStartedError();
    if (outcome.status === "foreign") throw new ValidationError("Некорректный забег");
    if (outcome.status === "created") {
      this.logger.log(JSON.stringify({ module: "boosts", event: "bought", accountId, runId, boosts: outcome.row.boosts, cost: outcome.row.cost }));
    }
    return { runId: outcome.row.runId, boosts: outcome.row.boosts, cost: outcome.row.cost };
  }

  /**
   * Вернуть бусты забегу, который не начался: движок не загрузился, игрок
   * закрыл приложение на экране загрузки. Начатому — нет: бусты потрачены.
   */
  async refund(accountId: string, runId: string, at = new Date()): Promise<{ refunded: boolean }> {
    const outcome = await this.repository.refund(accountId, runId, at);
    if (outcome === "refunded") {
      this.logger.log(JSON.stringify({ module: "boosts", event: "refunded", accountId, runId }));
      this.announceRefund(accountId, runId, at);
    }
    return { refunded: outcome === "refunded" };
  }

  /**
   * Возврат — в ленту (Р51): чаще его делает проход по брошенным забегам, и
   * иначе игрок не узнал бы, откуда вернулись монеты.
   */
  announceRefund(accountId: string, runId: string, at: Date): void {
    void this.repository
      .byRun(runId)
      .then((row) => {
        if (row === null) return;
        this.notifications.post({
          accountId,
          kind: "boosts_refunded",
          payload: { runId, boosts: row.boosts, coins: row.cost.coins ?? 0, gems: row.cost.gems ?? 0 },
          dedupeKey: `boosts_refunded:${runId}`,
          at,
        });
      })
      .catch((error: unknown) => {
        this.logger.warn(JSON.stringify({ module: "boosts", event: "refund_notice_failed", runId, reason: error instanceof Error ? error.message : "unknown" }));
      });
  }

  /** Заявленные в итоге бусты — все куплены на этот забег и не возвращены. */
  async checkClaimed(accountId: string, runId: string, claimed: readonly string[]): Promise<"paid" | "unpaid"> {
    const row = await this.repository.byRun(runId);
    if (row === null || row.accountId !== accountId || row.refundedAt !== null) return "unpaid";
    return claimed.every((id) => row.boosts.includes(id)) ? "paid" : "unpaid";
  }

  /** Бусты, купленные на свой забег; возвращённые за незапущенный забег не в счёт. */
  async ofRun(accountId: string, runId: string): Promise<string[]> {
    const row = await this.repository.byRun(runId);
    if (row === null || row.accountId !== accountId || row.refundedAt !== null) return [];
    return row.boosts;
  }
}
