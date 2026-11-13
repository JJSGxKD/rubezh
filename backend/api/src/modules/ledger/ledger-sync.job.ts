import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { DomainError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { createQueueConnection } from "../../infra/queues.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { LedgerService, type LedgerPostInput, type PostResult } from "./ledger.service.js";
import { planPostings, type PostingKind } from "./payment-postings.js";
import {
  PAYMENT_POSTINGS_REPOSITORY,
  cursorOf,
  type PaymentPostingsRepository,
  type PostingCandidate,
  type PostingStream,
  type StreamCursor,
} from "./payment-postings.repository.js";

/**
 * Сверка платежей с журналом учёта (docs/37-accounting.md §8; Р219, tasks/T-0458). Не хуки, а сверка таблицы
 * с журналом: слушатель `PaymentsHooks.onPaid` живёт в памяти процесса, упал он — проводка потеряна навсегда.
 * Задание раз в десять минут находит в `purchase` то, чего ещё нет в журнале, и досоздаёт: оплату, выход из
 * холда, возврат. Идемпотентность — ключ источника проводки (`purchase:<id>:paid|release|refund`, T-0457), так что
 * перезапуск, сбой базы, выкат посреди оплаты и две реплики сразу ничего не удваивают.
 *
 * Досоздание за прошлое — это первый проход после выката, отдельного скрипта нет: он идёт кругами по
 * `SYNC_LIMIT` покупок и, если выборка вернула полный круг, не ждёт следующего расписания.
 */

export const LEDGER_SYNC_QUEUE = "ledger";
const SCHEDULER_ID = "every-10-min";

/** Как часто расписание запускает проход. */
export const SYNC_INTERVAL_MS = 600_000;
/** Покупок в одной выборке; полный круг значит «возможно, есть ещё». */
export const SYNC_LIMIT = 500;
/** Кругов на один проход: потолок 20 000 покупок, дальше проход возвращает «не всё» и продолжит следующий. */
const MAX_ROUNDS = 40;
/** Проход укладывается в окно расписания с запасом: без него следующий запуск шёл бы поверх. */
const BUDGET_MS = 480_000;
const SELECT_TIMEOUT_MS = 30_000;
const POST_TIMEOUT_MS = 10_000;
/** Сколько предупреждений об одной и той же непроводимой покупке помнить, чтобы не повторять их каждые десять минут. */
const WARNED_LIMIT = 1_000;
/** Сколько длительностей проходов помнит счётчик в памяти. */
const DURATIONS_LIMIT = 1_000;

const STREAMS: readonly PostingStream[] = ["unpaid", "unreleased", "unrefunded"];

export type PostingResult = "created" | "exists" | "failed";

/**
 * Метрики сверки с именами и метками, которые получит Prometheus, когда он появится в бэкенде
 * (`docs/22-analytics-and-metrics.md`, «Заготовка метрики»): `ledger_postings_total{kind,result}` и
 * `ledger_sync_duration_seconds`. Метки низкой кардинальности — вид и исход; покупки и аккаунтов в метках нет.
 */
export class LedgerSyncMetrics {
  private readonly postings = new Map<string, number>();
  /** Длительности последних проходов, секунды. */
  readonly durations: number[] = [];

  record(kind: PostingKind, result: PostingResult): void {
    const key = `${kind}:${result}`;
    this.postings.set(key, (this.postings.get(key) ?? 0) + 1);
  }

  count(kind: PostingKind, result: PostingResult): number {
    return this.postings.get(`${kind}:${result}`) ?? 0;
  }

  observe(seconds: number): void {
    this.durations.push(seconds);
    if (this.durations.length > DURATIONS_LIMIT) this.durations.shift();
  }
}

type KindCounts = Record<PostingResult, number>;

export interface SyncResult {
  /** сколько кругов выборок сделано */
  rounds: number;
  /** все выборки вернули меньше лимита — догонять нечего; `false` — упёрлись в предел кругов или время */
  drained: boolean;
  postings: Record<PostingKind, KindCounts>;
  /** покупки с другой площадки: в учёт не идут, статей для них пока нет */
  unsupported: number;
  /** покупки с суммой не больше нуля */
  badAmount: number;
  durationSec: number;
}

function emptyCounts(): KindCounts {
  return { created: 0, exists: 0, failed: 0 };
}

/** Что проход берёт у журнала: достаточно записи проводки. */
type PostingLedger = { post(input: LedgerPostInput): Promise<PostResult> };

/** Причина отказа для лога: у доменной ошибки — код и текст (они безопасны), у остальных — только имя. */
function reasonOf(error: unknown): { reason: string; detail?: string } {
  if (error instanceof DomainError) return { reason: error.code, detail: error.message };
  return { reason: error instanceof Error ? error.name : "unknown" };
}

@Injectable()
export class LedgerSyncPass {
  private readonly logger = new Logger("ledger");
  readonly metrics = new LedgerSyncMetrics();
  private readonly warned = new Set<string>();
  /** Часы; тест двигает их, чтобы пройти срок холда. */
  clock: () => Date = () => new Date();
  /** Покупок в одной выборке; тест уменьшает, чтобы не создавать сотни оплат. */
  limit = SYNC_LIMIT;
  maxRounds = MAX_ROUNDS;
  budgetMs = BUDGET_MS;

  constructor(
    @Inject(PAYMENT_POSTINGS_REPOSITORY) private readonly repository: PaymentPostingsRepository,
    @Inject(LedgerService) private readonly ledger: PostingLedger,
    @Inject(SETTINGS_READER) private readonly settings: Pick<SettingsReader, "get">,
  ) {}

  /**
   * Один проход: круги из трёх выборок, пока они возвращают полный круг. Покупка, которую не удалось провести,
   * в этом проходе второй раз не берётся — курсор уходит за неё; следующий проход попробует снова.
   */
  async run(): Promise<SyncResult> {
    const started = performance.now();
    const result: SyncResult = {
      rounds: 0,
      drained: false,
      postings: { paid: emptyCounts(), release: emptyCounts(), refund: emptyCounts() },
      unsupported: 0,
      badAmount: 0,
      durationSec: 0,
    };
    try {
      // Срок холда читается один раз за проход: настройка не должна поменяться на полпути между оплатами одной пачки.
      const holdDays = this.settings.get(SETTINGS.paymentsHoldDaysTelegram);
      const active = new Set<PostingStream>(STREAMS);
      const cursors = new Map<PostingStream, StreamCursor>();
      while (active.size > 0 && result.rounds < this.maxRounds && (result.rounds === 0 || performance.now() - started < this.budgetMs)) {
        result.rounds += 1;
        const now = this.clock();
        // Покупка, найденная двумя выборками разом (оплата и возврат), в круге обрабатывается один раз.
        const batch = new Map<string, PostingCandidate>();
        for (const stream of [...active]) {
          const chunk = await withTimeout(this.repository.candidates(stream, now, cursors.get(stream) ?? null, this.limit), SELECT_TIMEOUT_MS, `ledger-sync: выборка «${stream}»`);
          const last = chunk.at(-1);
          if (last === undefined || chunk.length < this.limit) active.delete(stream);
          else cursors.set(stream, cursorOf(stream, last));
          for (const candidate of chunk) if (!batch.has(candidate.purchase.purchaseId)) batch.set(candidate.purchase.purchaseId, candidate);
        }
        for (const candidate of batch.values()) await this.process(candidate, holdDays, now, result);
      }
      result.drained = active.size === 0;
    } finally {
      result.durationSec = (performance.now() - started) / 1000;
      this.metrics.observe(result.durationSec);
    }
    this.report(result);
    return result;
  }

  /** Проводки одной покупки по порядку; первая неудача останавливает покупку: «возврат» без «выхода» провести нельзя. */
  private async process(candidate: PostingCandidate, holdDays: number, now: Date, result: SyncResult): Promise<void> {
    const { purchase, posted } = candidate;
    const plan = planPostings({ purchase, holdDays, now, posted });
    if (plan.warning !== null) {
      if (plan.warning === "unsupported_platform") result.unsupported += 1;
      else result.badAmount += 1;
      this.warnOnce(plan.warning, purchase.purchaseId, plan.warning === "unsupported_platform" ? { platform: purchase.platform } : {});
      return;
    }
    for (const posting of plan.postings) {
      try {
        const outcome = await withTimeout(this.ledger.post(posting.entry), POST_TIMEOUT_MS, `ledger-sync: проводка «${posting.kind}»`);
        const status: PostingResult = outcome.created ? "created" : "exists";
        result.postings[posting.kind][status] += 1;
        this.metrics.record(posting.kind, status);
      } catch (error: unknown) {
        result.postings[posting.kind].failed += 1;
        this.metrics.record(posting.kind, "failed");
        this.logger.warn(JSON.stringify({ module: "ledger", event: "ledger_posting_failed", purchaseId: purchase.purchaseId, kind: posting.kind, ...reasonOf(error) }));
        return;
      }
    }
  }

  /** Предупреждение о непроводимой покупке — раз за жизнь процесса: она будет в выборке каждые десять минут. */
  private warnOnce(warning: "unsupported_platform" | "bad_amount", purchaseId: string, extra: Record<string, string>): void {
    const key = `${warning}:${purchaseId}`;
    if (this.warned.has(key)) return;
    if (this.warned.size >= WARNED_LIMIT) this.warned.clear();
    this.warned.add(key);
    this.logger.warn(JSON.stringify({ module: "ledger", event: warning === "unsupported_platform" ? "ledger_unsupported_platform" : "ledger_bad_amount", purchaseId, ...extra }));
  }

  /** Итог прохода в лог — только когда что-то произошло или осталось недоведённым: пустой проход раз в десять минут — шум. */
  private report(result: SyncResult): void {
    const created = result.postings.paid.created + result.postings.release.created + result.postings.refund.created;
    const failed = result.postings.paid.failed + result.postings.release.failed + result.postings.refund.failed;
    if (created === 0 && failed === 0 && result.drained) return;
    this.logger.log(
      JSON.stringify({
        module: "ledger",
        event: "ledger_sync_pass",
        rounds: result.rounds,
        drained: result.drained,
        created: { paid: result.postings.paid.created, release: result.postings.release.created, refund: result.postings.refund.created },
        failed,
        durationSec: Math.round(result.durationSec * 1000) / 1000,
      }),
    );
  }
}

/**
 * Расписание сверки: повторяющееся задание BullMQ каждые десять минут. Планировщик с одним id идемпотентен —
 * перезапуск и соседние реплики не заводят второе расписание, а задание выполняет одна из них. Проход, не
 * дошедший до конца (старое прошлое после выката), ставит себе продолжение сразу.
 */
@Injectable()
export class LedgerSyncJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("ledger");
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly pass: LedgerSyncPass,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.databaseUrl === "") return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(LEDGER_SYNC_QUEUE, { connection: producer });
    this.worker = new Worker(LEDGER_SYNC_QUEUE, async () => await this.process(), { connection: consumer, concurrency: 1 });
    this.worker.on("failed", (_job, error) => this.logger.warn(JSON.stringify({ module: "ledger", event: "sync_failed", reason: error.name })));
    // Без обработчика ошибка соединения воркера роняла бы процесс.
    this.worker.on("error", (error) => this.logger.warn(JSON.stringify({ module: "ledger", event: "worker_error", reason: error.name })));
    try {
      // Завершённые задания не копятся в Redis: проход идёт круглые сутки.
      await this.queue.upsertJobScheduler(SCHEDULER_ID, { every: SYNC_INTERVAL_MS }, { name: "sync", opts: { removeOnComplete: 100, removeOnFail: 100 } });
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "ledger", event: "schedule_failed", reason: error instanceof Error ? error.name : "unknown" }));
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }

  /** Проход и, если до конца не дошли, продолжение: догоняем прошлое, а не ждём ещё десять минут. */
  private async process(): Promise<void> {
    const result = await this.pass.run();
    if (result.drained || this.queue === null) return;
    // Своё имя задания на каждое продолжение: одинаковое отсекло бы его, пока предыдущее ещё идёт.
    await this.queue.add("sync-continue", {}, { jobId: `sync-continue-${String(Date.now())}`, removeOnComplete: 100, removeOnFail: 100 });
  }
}
