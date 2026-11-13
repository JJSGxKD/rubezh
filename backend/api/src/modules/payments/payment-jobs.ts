import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { ForbiddenError } from "../../common/domain-error.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { PaymentFeedSources } from "./payment-feed-sources.js";
import type { FeedMark, TimelineEntry } from "./payment-timeline.js";
import { PaymentJobNotFoundError, PurchaseActionUnavailableError } from "./payments-errors.js";
import { PaymentsHooks } from "./payments-hooks.js";
import { PaymentsQueue, type FailedPaymentJob } from "./payments-queue.js";
import type { PurchaseAction, StoredPurchase } from "./purchase-types.js";
import { PURCHASES_REPOSITORY, type PurchasesRepository } from "./purchases.repository.js";

/**
 * Брошенные задания очереди оплаты в панели (Р209, WP53, tasks/T-0431): список,
 * повтор одного задания и источник карточки платежа — строка хронологии,
 * пометка ленты и действие «Повторить учёт». «Повторить учёт» по покупке —
 * `payment-retry.ts`.
 *
 * Повтор — тот же, что делала команда на сервере (`cli/payments-retry-failed.ts`):
 * задание целиком, со свежей серией попыток. Ничего не удваивается — запись
 * оплаты, выдача и возврат идемпотентны (`payments-queue.ts`). Право: список —
 * `payments.view`, повтор — `payments.support`; свою покупку не повторяют, как
 * не возвращают звёзды за неё (`purchase-support.ts`), кроме входа разработчика.
 *
 * Очередь выключена или Redis не отвечает — список отвечает «недоступна», а не
 * «брошенных нет»: пустой список успокоил бы команду зря.
 */

/** Сколько заданий показывает список: больше человек не прочтёт, а остальное он увидит повторив эти. */
const LIST_LIMIT = 200;
/** Сколько брошенных заданий ищет повтор и читает источник карточки: ровно столько очередь и хранит (`removeOnFail`). */
export const FAILED_LOOKUP_LIMIT = 1000;
const TEXT_MAX = 200;

export const QUEUE_UNAVAILABLE = "Очередь оплаты недоступна: Redis не отвечает или оплата выключена";
const ALREADY_NOT_FAILED = "Задание уже не брошено: его повторили или оно выполнилось";

/** Подписи видов задания — в хронологии и в сообщении команде. */
const KIND_LABELS: Readonly<Record<FailedPaymentJob["kind"], string>> = {
  confirm: "подтверждение оплаты",
  refund: "возврат",
  refunded: "внешний возврат",
  unknown: "неизвестное задание",
};

const uuid = z.uuid();

/**
 * Чьё задание. Подтверждение и заказанный возврат несут id покупки; внешний
 * возврат приходит от площадки с одним номером оплаты, и покупка находится по
 * нему. Номер оплаты у подтверждения не в счёт: записи оплаты в базе ещё может
 * не быть, а лёгший в базу номер принадлежит покупке, которую подтверждение и
 * называет.
 */
export function jobBelongsTo(job: FailedPaymentJob, purchase: Pick<StoredPurchase, "purchaseId" | "telegramChargeId">): boolean {
  switch (job.kind) {
    case "confirm":
    case "refund":
      return job.purchaseId !== null && job.purchaseId === purchase.purchaseId;
    case "refunded":
      return job.chargeId !== null && purchase.telegramChargeId !== null && job.chargeId === purchase.telegramChargeId;
    case "unknown":
      return false;
  }
}

/**
 * Брошенные задания для действия человека в панели. Очереди нет или она не
 * ответила за положенное время — `null`: панель говорит «недоступна», а не
 * падает ошибкой сервера, пока Redis лежит. Причина — в лог вызывающего.
 */
export async function readFailedJobs(queue: Pick<PaymentsQueue, "failedJobs">, limit: number, onError: (reason: string) => void): Promise<FailedPaymentJob[] | null> {
  try {
    return await queue.failedJobs(limit);
  } catch (error: unknown) {
    onError(error instanceof Error ? error.message : "unknown");
    return null;
  }
}

/** Свою покупку не повторяют — только вход разработчика, чтобы проверить на себе. */
export function forbidOwnPurchase(config: AppConfig, actor: AccountRef, purchase: Pick<StoredPurchase, "accountId">): void {
  if (actor.accountId === purchase.accountId && !config.auth.devLogin) throw new ForbiddenError("Повторять учёт своей покупки нельзя");
}

/**
 * Имя — как в аккаунте; нет аккаунта или он не прочитался — его id: действие уже выполнено, и сообщение
 * команде не должно из-за имени превратиться в ошибку запроса.
 */
export async function actorNameOf(accounts: Pick<AccountRepository, "byId">, actor: AccountRef, onUnread: (reason: string) => void): Promise<string> {
  try {
    return (await accounts.byId(actor.accountId))?.displayName ?? actor.accountId;
  } catch (error: unknown) {
    onUnread(error instanceof Error ? error.message : "unknown");
    return actor.accountId;
  }
}

@Injectable()
export class PaymentJobs implements OnModuleInit {
  private readonly logger = new Logger("payments");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly queue: PaymentsQueue,
    @Inject(PURCHASES_REPOSITORY) private readonly purchases: Pick<PurchasesRepository, "byId">,
    private readonly roles: RolesService,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    private readonly hooks: PaymentsHooks,
    private readonly sources: PaymentFeedSources,
  ) {}

  onModuleInit(): void {
    this.sources.register("jobs", {
      timeline: (purchase) => this.timeline(purchase),
      marks: (purchaseIds) => this.marks(purchaseIds),
      actions: (purchase) => this.actions(purchase),
    });
  }

  /**
   * Брошенные задания, свежие первыми. Идентификатор плательщика на площадке —
   * персональные данные: без `players.pii.view` он стёрт, как в карточке платежа.
   */
  async list(actor: AccountRef): Promise<{ available: boolean; jobs: FailedPaymentJob[] }> {
    await this.roles.require(actor, "payments.view");
    const failed = await readFailedJobs(this.queue, LIST_LIMIT, (reason) => this.log("warn", "payment_jobs_unreadable", { reason }));
    if (failed === null) return { available: false, jobs: [] };
    const withPayer = await this.roles.can(actor, "players.pii.view");
    return { available: true, jobs: withPayer ? failed : failed.map((job) => ({ ...job, payerId: null })) };
  }

  /**
   * Повторить одно брошенное задание. Задание ищется среди брошенных, а не
   * берётся по идентификатору вслепую: по нему узнаются вид, оплата и покупка —
   * для проверки «своя ли» и для журнала.
   */
  async retryJob(actor: AccountRef, jobId: string, note: string, now = new Date()): Promise<{ jobId: string; purchaseId: string | null }> {
    await this.roles.require(actor, "payments.support");
    const failed = await readFailedJobs(this.queue, FAILED_LOOKUP_LIMIT, (reason) => this.log("warn", "payment_jobs_unreadable", { reason }));
    if (failed === null) throw new PurchaseActionUnavailableError(QUEUE_UNAVAILABLE);
    const job = failed.find((candidate) => candidate.jobId === jobId);
    if (job === undefined) throw await this.whyNotFailed(jobId);

    const purchase = await this.purchaseOf(job);
    if (purchase !== null) forbidOwnPurchase(this.config, actor, purchase);

    const outcome = await this.queue.retryFailed(jobId);
    if (outcome === "not_found") throw new PaymentJobNotFoundError();
    if (outcome === "not_failed") throw new PurchaseActionUnavailableError(ALREADY_NOT_FAILED);

    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "payments.job.retry",
      target: purchase?.accountId ?? null,
      after: { jobId, kind: job.kind, chargeId: job.chargeId, purchaseId: job.purchaseId, note },
    });
    if (purchase !== null) {
      const actorName = await actorNameOf(this.accounts, actor, (reason) => this.log("warn", "payment_job_name_unread", { actorAccountId: actor.accountId, reason }));
      await this.hooks.emitSupport({ kind: "retry", purchase, actorName, note, at: now, detail: `повторено задание: ${KIND_LABELS[job.kind]}` });
    }
    this.log("log", "payment_job_retried", { jobId, kind: job.kind, purchaseId: job.purchaseId, actorAccountId: actor.accountId });
    return { jobId, purchaseId: job.purchaseId };
  }

  /**
   * Задания нет среди брошенных: после повтора оно уходит из списка в очередь
   * или выполняется, и повторное нажатие — не «не найдено», а «уже не брошено»
   * (409). Не найдено — когда задания нет совсем. Задание брошено, но в прочитанные
   * 1000 не попало, — тоже «не найдено»: вид и покупка неизвестны, «своя ли» не
   * проверить, а вслепую повторять нельзя.
   */
  private async whyNotFailed(jobId: string): Promise<PaymentJobNotFoundError | PurchaseActionUnavailableError> {
    try {
      return (await this.queue.jobState(jobId)) === "not_failed" ? new PurchaseActionUnavailableError(ALREADY_NOT_FAILED) : new PaymentJobNotFoundError();
    } catch (error: unknown) {
      this.log("warn", "payment_job_state_unreadable", { jobId, reason: error instanceof Error ? error.message : "unknown" });
      return new PurchaseActionUnavailableError(QUEUE_UNAVAILABLE);
    }
  }

  /** Покупка задания. Нет покупки (внешний возврат, мусор в счёте, покупку удалили) — `null`: повтор от этого не зависит. */
  private async purchaseOf(job: FailedPaymentJob): Promise<StoredPurchase | null> {
    // В базу — только настоящий UUID: счёт в задании приходит от площадки, и мусор в нём не должен стать ошибкой запроса.
    if (job.purchaseId === null || !uuid.safeParse(job.purchaseId).success) return null;
    return this.purchases.byId(job.purchaseId);
  }

  private async abandoned(): Promise<FailedPaymentJob[]> {
    return (await this.queue.failedJobs(FAILED_LOOKUP_LIMIT)) ?? [];
  }

  private async timeline(purchase: StoredPurchase): Promise<TimelineEntry[]> {
    const lines: TimelineEntry[] = [];
    for (const job of await this.abandoned()) {
      // Задание без времени сбоя: строке некуда встать в хронологии.
      if (job.failedAt === null || !jobBelongsTo(job, purchase)) continue;
      const why = job.reason === "" ? "" : ` — ${job.reason}`;
      lines.push({ at: job.failedAt, kind: "job_abandoned", text: fit(`Задание оплаты брошено: ${KIND_LABELS[job.kind]}${why}`), actorName: null });
    }
    return lines;
  }

  /**
   * Покупки страницы, у которых есть брошенное задание. Нет брошенных — ни одного
   * чтения базы: так бывает почти всегда. Покупку по номеру оплаты (внешний
   * возврат) приходится читать, но только тех, кого не нашли по самому заданию.
   */
  private async marks(purchaseIds: readonly string[]): Promise<Map<string, readonly FeedMark[]>> {
    const marked = new Map<string, readonly FeedMark[]>();
    const jobs = await this.abandoned();
    if (jobs.length === 0) return marked;
    const named = new Set(jobs.flatMap((job) => (job.purchaseId !== null && (job.kind === "confirm" || job.kind === "refund") ? [job.purchaseId] : [])));
    const rest: string[] = [];
    for (const purchaseId of purchaseIds) {
      if (named.has(purchaseId)) marked.set(purchaseId, ["job_abandoned"]);
      else rest.push(purchaseId);
    }
    if (!jobs.some((job) => job.kind === "refunded" && job.chargeId !== null)) return marked;
    await Promise.all(
      rest.map(async (purchaseId) => {
        const purchase = await this.purchases.byId(purchaseId);
        if (purchase !== null && jobs.some((job) => jobBelongsTo(job, purchase))) marked.set(purchaseId, ["job_abandoned"]);
      }),
    );
    return marked;
  }

  private async actions(purchase: StoredPurchase): Promise<PurchaseAction[]> {
    return (await this.abandoned()).some((job) => jobBelongsTo(job, purchase)) ? ["retry"] : [];
  }

  private log(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "payments", event, ...fields }));
  }
}

/** Строка хронологии — не длиннее 200 знаков: срез по знакам, а не по кодовым единицам — пара суррогатов не рвётся. */
function fit(text: string): string {
  const chars = [...text];
  return chars.length <= TEXT_MAX ? text : `${chars.slice(0, TEXT_MAX - 1).join("")}…`;
}
