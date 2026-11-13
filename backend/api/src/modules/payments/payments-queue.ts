import { createHash } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { withTimeout } from "../../common/with-timeout.js";
import { createQueueConnection } from "../../infra/queues.js";
import { PaymentProviders } from "../../platforms/ports/payment-provider.js";
import { RunsHooks } from "../runs/runs-hooks.js";
import { PaymentConfirmation, type ConfirmedPayment } from "./payment-confirmation.js";
import { PaymentRefunds } from "./payment-refunds.js";
import { PaymentsHooks } from "./payments-hooks.js";
import { PurchaseFulfillment } from "./purchase-fulfillment.js";
import { PURCHASES_REPOSITORY, type ConfirmOutcome, type PurchasesRepository, type RefundOrder } from "./purchases.repository.js";

/**
 * Очередь оплаты: подтверждения от Telegram и возвраты звёзд идут через неё,
 * а не прямо из обработчика обновления.
 *
 * Смещение опроса бота сохраняется до обработки, а вебхук отвечает Telegram
 * сразу (`bot-poller.ts`, `bot-webhook.controller.ts`): обновление, чья
 * обработка упала, второй раз не придёт. Для команды это потерянный ответ,
 * для оплаты — звёзды без продолжения. Поэтому подтверждение сначала
 * ложится в Redis, а запись в базу повторяется с паузой, пока не пройдёт, и
 * переживает перезапуск процесса. Возврат — так же: не прошёл — повтор, а не
 * молча (docs/34-stage3-plan.md, WP5, п. 5.2).
 *
 * Возврат, пришедший от Telegram (спор игрока, поддержка), — такое же
 * задание: смещение опроса к этому моменту уже сохранено, и сбой базы без
 * очереди потерял бы отметку навсегда, а выручка осталась бы завышенной.
 * Задание, не прошедшее ни одной из десяти попыток, выходит слушателям
 * (`PaymentsHooks.onAbandoned`): команда узнаёт о нём сообщением, а не из лога.
 *
 * Товар магазина выдаётся тем же заданием, последним шагом: не вышло —
 * задание повторяется целиком, запись оплаты отвечает «уже записано», а
 * выдача идемпотентна ключом покупки.
 *
 * Брошенное задание очередь хранит (`removeOnFail`): панель читает их
 * (`failedJobs`) и повторяет кнопкой (`retryFailed`) — тем же путём, что
 * команда на сервере, со свежей серией попыток (Р209, WP53, tasks/T-0431).
 *
 * Redis недоступен — задание выполняется сразу: оплата не должна ждать
 * очередь. Не вышло и так — ошибка в лог со всеми полями оплаты: по ним
 * человек сверит покупку руками. Заказанный возврат к тому же записан в базе,
 * и после перезапуска очередь поднимет его оттуда.
 */

const QUEUE_NAME = "payments";
const ENQUEUE_TIMEOUT_MS = 2_000;
/** Чтение и повтор брошенных заданий идут по просьбе человека из панели: подождать можно дольше, чем при приёме оплаты. */
const FAILED_TIMEOUT_MS = 5_000;
/** Причина в строке панели и хронологии: первая строка сообщения, не весь стек. */
const REASON_MAX = 200;
const JOB_OPTIONS = {
  attempts: 10,
  backoff: { type: "exponential", delay: 2_000, jitter: 0.5 },
  removeOnComplete: 1000,
  removeOnFail: 1000,
} as const;
/** Сколько незавершённых возвратов поднимать на старте: больше их бывает только при долгом сбое Telegram. */
const PENDING_REFUNDS_ON_START = 500;

type PaymentsJob =
  | { kind: "confirm"; payment: ConfirmedPayment }
  | { kind: "refund"; order: RefundOrder }
  /** возврат, о котором сообщила площадка; `at` — когда пришло обновление, а не когда запись прошла */
  | { kind: "refunded"; chargeId: string; at: number };

/** Брошенное задание очереди — строка для панели (Р209, WP53). Поля, которых в данных задания нет или они не разобрались, — `null`. */
export interface FailedPaymentJob {
  jobId: string;
  kind: "confirm" | "refund" | "refunded" | "unknown";
  chargeId: string | null;
  purchaseId: string | null;
  payerId: string | null;
  /** у подтверждения — сумма оплаты; у возвратов — null */
  amount: number | null;
  /** первая непустая строка причины, до 200 знаков */
  reason: string;
  attempts: number;
  /** когда задание бросилось (`finishedOn`); нет — null */
  failedAt: Date | null;
}

/** Название события в логе, если задание не удалось выполнить даже без очереди. */
const UNRECORDED_EVENTS: Record<PaymentsJob["kind"], string> = {
  confirm: "payment_unrecorded",
  refund: "refund_unsent",
  refunded: "refund_unrecorded",
};

@Injectable()
export class PaymentsQueue implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("payments");
  private queue: Queue<PaymentsJob> | null = null;
  private worker: Worker<PaymentsJob> | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly confirmation: PaymentConfirmation,
    private readonly refunds: PaymentRefunds,
    private readonly runsHooks: RunsHooks,
    private readonly providers: PaymentProviders,
    private readonly fulfillment: PurchaseFulfillment,
    @Inject(PURCHASES_REPOSITORY) private readonly purchases: Pick<PurchasesRepository, "markFulfilled">,
    // Слушатели нужны модулю, а не каждому тесту очереди: без них — пустой список.
    private readonly hooks: PaymentsHooks = new PaymentsHooks(),
  ) {}

  /** Оплату есть куда записать и есть кому о ней сообщить: база и площадка, которая присылает подтверждения. */
  get enabled(): boolean {
    return this.config.auth.enabled && this.providers.anyConfirms;
  }

  onModuleInit(): void {
    // Забег с оплаченным, но не взятым продолжением — звёзды возвращаются.
    if (this.enabled) this.runsHooks.onRecorded("payments", (run) => this.dispatchRefunds(this.refunds.afterRun(run.runId, run.continues)));
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(QUEUE_NAME, { connection: producer });
    this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), { connection: consumer, concurrency: 2 });
    this.worker.on("failed", (job, error) => {
      if (job !== undefined) void this.jobFailed(job, error);
    });
    this.worker.on("error", (error) => this.log("warn", "worker_error", { reason: error.message }));
    // Не блокирует старт: база или Redis могут быть ещё не готовы, а возвраты
    // подождут следующего перезапуска.
    void this.dispatchRefunds(this.refunds.pending(PENDING_REFUNDS_ON_START));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }

  async confirm(payment: ConfirmedPayment): Promise<void> {
    await this.run({ kind: "confirm", payment }, `confirm-${fingerprint(payment.chargeId)}`);
  }

  /** Возврат от площадки: игрок оспорил оплату или вернула поддержка. Ошибка сюда не пробивается — как у `confirm`. */
  async refunded(chargeId: string, nowMs = Date.now()): Promise<void> {
    await this.run({ kind: "refunded", chargeId, at: nowMs }, `refunded-${fingerprint(chargeId)}`);
  }

  /**
   * Брошенные задания, свежие первыми (BullMQ отдаёт их по времени провала).
   * Очереди нет — `null`: панель говорит «недоступна», а не «брошенных нет».
   */
  async failedJobs(limit: number): Promise<FailedPaymentJob[] | null> {
    if (this.queue === null) return null;
    const jobs = await withTimeout(this.queue.getFailed(0, limit - 1), FAILED_TIMEOUT_MS, "брошенные задания оплаты");
    return jobs.map(viewOf);
  }

  /**
   * Повторить брошенное задание целиком со свежей серией попыток: иначе первая
   * же неудача снова была бы «последней». Запись оплаты идемпотентна по
   * идентификатору оплаты, выдача — по ключу покупки, возврат — по
   * идентификатору оплаты, так что повтор ничего не удваивает. Задание успели
   * повторить, пока человек смотрел список, — `not_failed`, а не ошибка.
   */
  async retryFailed(jobId: string): Promise<"retried" | "not_found" | "not_failed"> {
    if (this.queue === null) return "not_found";
    const job = await withTimeout(this.queue.getJob(jobId), FAILED_TIMEOUT_MS, "задание оплаты");
    if (job === undefined) return "not_found";
    if ((await withTimeout(job.getState(), FAILED_TIMEOUT_MS, "состояние задания оплаты")) !== "failed") return "not_failed";
    try {
      await withTimeout(job.retry("failed", { resetAttemptsMade: true, resetAttemptsStarted: true }), FAILED_TIMEOUT_MS, "повтор задания оплаты");
      return "retried";
    } catch (error: unknown) {
      // BullMQ отказывает, когда задание уже не в «failed»: его повторил другой. Причина — в лог, на случай, если это был не он.
      this.log("warn", "failed_job_retry_refused", { jobId, reason: reasonOf(error) });
      return "not_failed";
    }
  }

  /**
   * Попытка задания не удалась. Последняя — задание брошено: в лог уровнем
   * `error` и слушателям, чтобы команда узнала о нём без чтения логов. Не
   * бросает: вызывается из обработчика событий воркера. Вынесено ради тестов.
   */
  async jobFailed(job: Pick<Job<PaymentsJob>, "id" | "data" | "attemptsMade" | "opts">, error: Error): Promise<void> {
    const final = job.attemptsMade >= (job.opts.attempts ?? 1) || error.name === "UnrecoverableError";
    this.log(final ? "error" : "warn", final ? "payment_job_abandoned" : "payment_job_failed", {
      ...describeJob(job.data),
      attempts: job.attemptsMade,
      reason: error.message,
    });
    if (!final) return;
    try {
      await this.hooks.emitAbandoned({ jobId: job.id ?? "", kind: job.data.kind, ...identify(job.data), reason: error.message });
    } catch (hookError: unknown) {
      this.log("error", "abandoned_emit_failed", { jobId: job.id ?? "", reason: reasonOf(hookError) });
    }
  }

  /** Одно задание. Вынесено ради тестов: очередь вокруг — BullMQ. */
  async process(job: Pick<Job<PaymentsJob>, "data">): Promise<void> {
    const { data } = job;
    if (data.kind === "refund") {
      await this.refunds.refund(data.order);
      return;
    }
    if (data.kind === "refunded") {
      await this.confirmation.refunded(data.chargeId, data.at);
      return;
    }
    const outcome = await this.confirmation.confirm(data.payment);
    // Возврат заказывается после записи оплаты и отдельным заданием: упавший
    // возврат не должен повторять запись оплаты.
    await this.dispatchRefunds(this.refunds.afterConfirm(outcome, data.payment));
    await this.fulfill(outcome);
  }

  /**
   * Выдать оплаченное — и после повтора: `duplicate` — это и повтор
   * обновления, и повтор задания, у которого упала выдача. Выданное второй
   * раз не выдаётся: у выдачи свой ключ в журнале.
   */
  private async fulfill(outcome: ConfirmOutcome): Promise<void> {
    if (outcome.kind !== "paid" && outcome.kind !== "duplicate") return;
    const { purchase } = outcome;
    if (purchase.fulfilledAt !== null) return;
    if (!(await this.fulfillment.fulfill(purchase))) return;
    await this.purchases.markFulfilled(purchase.purchaseId, new Date());
    this.log("log", "purchase_fulfilled", { purchaseId: purchase.purchaseId, accountId: purchase.accountId, sku: purchase.sku });
  }

  /** Заказанные возвраты — заданиями очереди. Ошибка заказа в лог, наружу не пробивается. */
  async dispatchRefunds(orders: Promise<RefundOrder[]>): Promise<void> {
    try {
      for (const order of await orders) await this.run({ kind: "refund", order }, `refund-${fingerprint(order.chargeId)}`);
    } catch (error: unknown) {
      this.log("warn", "refund_order_failed", { reason: reasonOf(error) });
    }
  }

  /** В очередь, а без неё — сразу. Ошибка сюда не пробивается: чтение обновлений бота не должно падать. */
  private async run(job: PaymentsJob, jobId: string): Promise<void> {
    if (await this.enqueue(job, jobId)) return;
    try {
      await this.process({ data: job });
    } catch (error: unknown) {
      this.log("error", UNRECORDED_EVENTS[job.kind], { ...describeJob(job), reason: reasonOf(error) });
    }
  }

  private async enqueue(job: PaymentsJob, jobId: string): Promise<boolean> {
    if (this.queue === null) return false;
    try {
      // jobId от оплаты: повтор обновления не заведёт второе задание.
      await withTimeout(this.queue.add(job.kind, job, { jobId, ...JOB_OPTIONS }), ENQUEUE_TIMEOUT_MS, "очередь оплаты");
      return true;
    } catch (error: unknown) {
      this.log("warn", "enqueue_failed", { ...describeJob(job), reason: reasonOf(error) });
      return false;
    }
  }

  private log(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "payments", event, ...fields }));
  }
}

/**
 * Идентификатор оплаты Telegram — непрозрачная строка, а BullMQ не пускает
 * двоеточие в свои идентификаторы: в jobId идёт её отпечаток.
 */
function fingerprint(chargeId: string): string {
  return createHash("sha256").update(chargeId).digest("hex").slice(0, 32);
}

/** Оплата и покупка задания: по ним человек сверяет его руками. У внешнего возврата покупки в обновлении нет. */
function identify(job: PaymentsJob): { chargeId: string; purchaseId: string | null } {
  switch (job.kind) {
    case "confirm":
      return { chargeId: job.payment.chargeId, purchaseId: job.payment.payload };
    case "refund":
      return { chargeId: job.order.chargeId, purchaseId: job.order.purchaseId };
    case "refunded":
      return { chargeId: job.chargeId, purchaseId: null };
  }
}

function describeJob(job: PaymentsJob): Record<string, unknown> {
  if (job.kind === "refunded") return { kind: job.kind, chargeId: job.chargeId };
  if (job.kind === "refund") {
    const { order } = job;
    return { kind: job.kind, platform: order.platform, chargeId: order.chargeId, purchaseId: order.purchaseId, payerId: order.payerId, reason: order.reason };
  }
  const { payment } = job;
  return { kind: job.kind, platform: payment.platform, chargeId: payment.chargeId, purchaseId: payment.payload, payerId: payment.payerId, amount: payment.totalAmount };
}

// Данные задания из Redis — граница системы: разбираем схемой, а не приведением. Неполное не прячет строку:
// человеку нужно увидеть брошенное задание и всё, что о нём известно.
const text = z.string().nullable().catch(null);
const jobData = z
  .object({
    kind: z.enum(["confirm", "refund", "refunded", "unknown"]).catch("unknown"),
    payment: z.object({ chargeId: text, payload: text, payerId: text, totalAmount: z.number().finite().nullable().catch(null) }).optional().catch(undefined),
    order: z.object({ chargeId: text, purchaseId: text, payerId: text }).optional().catch(undefined),
    chargeId: text,
  })
  .catch({ kind: "unknown", chargeId: null });

type FailedJobSource = Pick<Job<PaymentsJob>, "id" | "data" | "failedReason" | "attemptsMade" | "finishedOn">;

function viewOf(job: FailedJobSource): FailedPaymentJob {
  const data = jobData.parse(job.data);
  const common = {
    jobId: job.id ?? "",
    reason: firstLine(job.failedReason),
    attempts: job.attemptsMade,
    failedAt: typeof job.finishedOn === "number" && Number.isFinite(job.finishedOn) ? new Date(job.finishedOn) : null,
  };
  switch (data.kind) {
    case "confirm":
      return { ...common, kind: "confirm", chargeId: data.payment?.chargeId ?? null, purchaseId: data.payment?.payload ?? null, payerId: data.payment?.payerId ?? null, amount: data.payment?.totalAmount ?? null };
    case "refund":
      return { ...common, kind: "refund", chargeId: data.order?.chargeId ?? null, purchaseId: data.order?.purchaseId ?? null, payerId: data.order?.payerId ?? null, amount: null };
    case "refunded":
      return { ...common, kind: "refunded", chargeId: data.chargeId, purchaseId: null, payerId: null, amount: null };
    case "unknown":
      return { ...common, kind: "unknown", chargeId: null, purchaseId: null, payerId: null, amount: null };
  }
}

/** Первая непустая строка причины, не длиннее 200 знаков: срез по знакам, а не по кодовым единицам — пара суррогатов не рвётся. */
function firstLine(reason: string | undefined): string {
  const line = (reason ?? "").split(/\r?\n/).find((candidate) => candidate.trim() !== "") ?? "";
  return [...line.trim()].slice(0, REASON_MAX).join("");
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
