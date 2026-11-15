import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { PaymentDiscrepancies } from "./payment-discrepancies.js";
import { FAILED_LOOKUP_LIMIT, QUEUE_UNAVAILABLE, actorNameOf, forbidOwnPurchase, jobBelongsTo, readFailedJobs } from "./payment-jobs.js";
import { PurchaseActionUnavailableError, PurchaseNotFoundError } from "./payments-errors.js";
import { PaymentsHooks } from "./payments-hooks.js";
import { PaymentsQueue, type FailedPaymentJob } from "./payments-queue.js";
import type { StoredPurchase } from "./purchase-types.js";
import { PURCHASES_REPOSITORY, type PurchasesRepository } from "./purchases.repository.js";

/**
 * «Повторить учёт» в карточке платежа (Р209, WP53, tasks/T-0431): все брошенные
 * задания очереди оплаты одной покупки повторяются разом — подтверждение,
 * заказанный возврат, внешний возврат. Повтор каждого — тот же, что у одного
 * задания (`payment-jobs.ts`): целиком, со свежей серией попыток, ничего не
 * удваивая.
 *
 * Право — `payments.support`, причина обязательна, действие — в журнале и
 * сообщением в поток «Покупки». Покупки нет — отказ, как у остальных действий;
 * своя — отказ, кроме входа разработчика.
 *
 * Покупка без брошенных заданий, но с открытым расхождением сверки («списано, но не
 * записано», «возврат не у нас») повторяется по выписке площадки (tasks/T-0434):
 * `PaymentDiscrepancies.retry` занимает расхождение, ставит задание по выписке и
 * сам пишет в журнал и в сообщение команде. Ответ тогда несёт `replayed` — id
 * расхождения. Нет ни заданий, ни такого расхождения — прежний отказ.
 */

const ALREADY_RETRYING = "Задание уже повторяется";

@Injectable()
export class PaymentRetry {
  private readonly logger = new Logger("payments");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly queue: PaymentsQueue,
    @Inject(PURCHASES_REPOSITORY) private readonly purchases: Pick<PurchasesRepository, "byId">,
    private readonly roles: RolesService,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    private readonly hooks: PaymentsHooks,
    private readonly discrepancies: PaymentDiscrepancies,
  ) {}

  async retry(actor: AccountRef, purchaseId: string, note: string, now = new Date()): Promise<{ retried: string[]; replayed: string | null }> {
    await this.roles.require(actor, "payments.support");
    const purchase = await this.purchases.byId(purchaseId);
    if (purchase === null) throw new PurchaseNotFoundError();
    forbidOwnPurchase(this.config, actor, purchase);

    const jobs = await this.abandonedJobs(purchase);
    if (jobs === null || jobs.length === 0) return await this.replayFromStatement(actor, purchase, note, now, jobs !== null);

    const retried: string[] = [];
    for (const job of jobs) {
      if ((await this.queue.retryFailed(job.jobId)) === "retried") retried.push(job.jobId);
    }
    // Все задания уже не брошены: двойное нажатие или параллельный повтор — второй записи в журнал не нужно.
    if (retried.length === 0) throw new PurchaseActionUnavailableError(ALREADY_RETRYING);

    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "payments.retry",
      target: purchase.accountId,
      after: { purchaseId, jobs: retried, note },
    });
    const actorName = await actorNameOf(this.accounts, actor, (reason) => this.log("warn", "payment_retry_name_unread", { actorAccountId: actor.accountId, reason }));
    await this.hooks.emitSupport({ kind: "retry", purchase, actorName, note, at: now, detail: `повторено заданий: ${String(retried.length)}` });
    this.log("log", "payment_retried", { purchaseId, accountId: purchase.accountId, jobs: retried.length, actorAccountId: actor.accountId });
    return { retried, replayed: null };
  }

  /**
   * Брошенных заданий нет: открытое расхождение сверки повторяется по выписке площадки. Очередь недоступна —
   * тоже сюда: повтору по выписке очередь не нужна, без неё задание выполнится сразу. Расхождения нет —
   * отказ, и текст зависит от того, видели ли мы очередь.
   */
  private async replayFromStatement(actor: AccountRef, purchase: StoredPurchase, note: string, now: Date, queueAvailable: boolean): Promise<{ retried: string[]; replayed: string | null }> {
    const discrepancyId = await this.discrepancies.retryableFor(purchase.purchaseId);
    if (discrepancyId === null) throw this.nothingToRetry(queueAvailable);
    await this.discrepancies.retry(actor, discrepancyId, note, now);
    return { retried: [], replayed: discrepancyId };
  }

  /** Брошенные задания покупки; очереди нет — `null`: заданий мы просто не видим. */
  private async abandonedJobs(purchase: StoredPurchase): Promise<FailedPaymentJob[] | null> {
    const failed = await readFailedJobs(this.queue, FAILED_LOOKUP_LIMIT, (reason) => this.log("warn", "payment_jobs_unreadable", { reason }));
    return failed === null ? null : failed.filter((job) => jobBelongsTo(job, purchase));
  }

  /** Отказ, когда повторять нечего: что делать дальше, говорит сам текст. */
  private nothingToRetry(queueAvailable: boolean): PurchaseActionUnavailableError {
    return new PurchaseActionUnavailableError(
      queueAvailable ? "Повторять нечего: брошенных заданий по этой покупке нет. Если звёзды списаны, а оплаты нет — запустите сверку с Telegram" : QUEUE_UNAVAILABLE,
    );
  }

  private log(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "payments", event, ...fields }));
  }
}
