import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { createQueueConnection } from "../../infra/queues.js";
import { NAME_RULE_HITS_REPOSITORY, type NameRuleHitsRepository } from "./name-rule-hits.repository.js";

/**
 * Счёт срабатываний правил фильтра имён (docs/35-stage4-plan.md, Р168,
 * tasks/T-0340). Вход игрока не ждёт ничего: `record` синхронный, копит в
 * памяти процесса, раз в 5 секунд пачка уходит в очередь BullMQ, а воркер
 * дописывает суточные счётчики одним запросом.
 *
 * Счёт **оценочный, а не точный**: пачка, которую не удалось поставить в очередь
 * (Redis недоступен), и пачка при сбое воркера теряются — повторов нет
 * (`attempts: 1`), это статистика, а не деньги. Потеря пишется в лог не чаще раза
 * в минуту, без id правил: в журналах нет ничего, по чему узнают игрока.
 */

export const NAME_RULE_HITS = Symbol("NAME_RULE_HITS");
export const NAME_RULE_HITS_TRANSPORT = Symbol("NAME_RULE_HITS_TRANSPORT");

export interface NameRuleHitsSink {
  /** Синхронно, без ожидания и без исключений: вход игрока не должен зависеть от статистики. */
  record(hits: readonly string[], saved: readonly string[]): void;
}

export const NAME_RULE_HITS_LIMITS = {
  /** пачка уходит в очередь раз в 5 с */
  flushMs: 5_000,
  retentionDays: 180,
  pruneEveryMs: 86_400_000,
  enqueueTimeoutMs: 2_000,
  /** разных id в буфере; правил не больше 2000, но предел держим */
  bufferMax: 5_000,
} as const;

/** Пачка за сутки UTC: сколько раз сработало каждое правило. */
export interface HitsBatch {
  /** `YYYY-MM-DD` */
  day: string;
  counts: Record<string, number>;
}

/** Путь пачки от входа до воркера; в тестах — подделка, в бою — очередь BullMQ. */
export interface NameRuleHitsTransport {
  /** Поставить пачку; ошибка — пачка потеряна. */
  send(batch: HitsBatch): Promise<void>;
  /** Запустить приём: обработчик зовётся на каждую пачку. */
  start(handler: (batch: HitsBatch) => Promise<void>): void;
  stop(): Promise<void>;
}

const QUEUE_NAME = "name-rule-hits";
const LOG_INTERVAL_MS = 60_000;

@Injectable()
export class BullNameRuleHitsTransport implements NameRuleHitsTransport {
  private queue: Queue<HitsBatch> | null = null;
  private worker: Worker<HitsBatch> | null = null;
  private connections: Redis[] = [];

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async send(batch: HitsBatch): Promise<void> {
    if (this.queue === null) throw new Error("очередь не запущена");
    await withTimeout(this.queue.add("hits", batch, { attempts: 1, removeOnComplete: 100, removeOnFail: 100 }), NAME_RULE_HITS_LIMITS.enqueueTimeoutMs, "счёт срабатываний: постановка в очередь");
  }

  start(handler: (batch: HitsBatch) => Promise<void>): void {
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue<HitsBatch>(QUEUE_NAME, { connection: producer });
    this.worker = new Worker<HitsBatch>(QUEUE_NAME, async (job) => await handler(job.data), { connection: consumer, concurrency: 1 });
    // Без обработчика ошибка соединения воркера роняла бы процесс; сбой записи уже залогирован обработчиком.
    this.worker.on("error", () => undefined);
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
    this.queue = null;
    this.worker = null;
    this.connections = [];
  }
}

@Injectable()
export class NameRuleHits implements NameRuleHitsSink, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("name-rules");
  private buffer = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private lastDroppedLogAt = Number.NEGATIVE_INFINITY;
  private lastPrunedAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => Date;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(NAME_RULE_HITS_TRANSPORT) private readonly transport: NameRuleHitsTransport,
    @Inject(NAME_RULE_HITS_REPOSITORY) private readonly repository: NameRuleHitsRepository,
    @Optional() clock?: () => Date,
  ) {
    this.now = clock ?? (() => new Date());
  }

  /** Очередь и таймер — когда есть база: без неё счёту некуда писать, и `record` — пустая функция. */
  onApplicationBootstrap(): void {
    if (this.config.databaseUrl === "") return;
    this.started = true;
    this.transport.start(async (batch) => await this.process(batch));
    this.timer = setInterval(() => void this.flush(), NAME_RULE_HITS_LIMITS.flushMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (!this.started) return;
    // Остаток буфера уходит с тем же таймаутом: остановка не должна зависнуть на Redis.
    await this.flush();
    await this.transport.stop();
    this.started = false;
  }

  record(hits: readonly string[], saved: readonly string[]): void {
    if (this.config.databaseUrl === "") return;
    if (hits.length === 0 && saved.length === 0) return;
    for (const ruleId of [...hits, ...saved]) {
      const current = this.buffer.get(ruleId);
      if (current !== undefined) {
        this.buffer.set(ruleId, current + 1);
        continue;
      }
      // Переполнение: новые id молча пропускаются, уже учтённые считаются дальше.
      if (this.buffer.size >= NAME_RULE_HITS_LIMITS.bufferMax) continue;
      this.buffer.set(ruleId, 1);
    }
  }

  /** Отправить накопленное; пустой буфер — задания нет. Не бросает: потеря пачки — только строка в логе. */
  async flush(): Promise<void> {
    if (this.buffer.size === 0) return;
    const counts = Object.fromEntries(this.buffer);
    this.buffer = new Map();
    const day = this.now().toISOString().slice(0, 10);
    try {
      await this.transport.send({ day, counts });
    } catch (error: unknown) {
      this.warnThrottled("name_rule_hits_dropped", error);
    }
  }

  /** Обработка пачки воркером: дописать счётчики, раз в сутки — стереть старое. Сбой — предупреждение, повтора нет. */
  async process(batch: HitsBatch): Promise<void> {
    try {
      await this.repository.addHits(batch.day, batch.counts);
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "name-rules", event: "name_rule_hits_failed", reason: errorName(error) }));
      return;
    }
    const at = this.now().getTime();
    if (at - this.lastPrunedAt < NAME_RULE_HITS_LIMITS.pruneEveryMs) return;
    this.lastPrunedAt = at;
    try {
      await this.repository.prune(NAME_RULE_HITS_LIMITS.retentionDays);
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "name-rules", event: "name_rule_hits_prune_failed", reason: errorName(error) }));
    }
  }

  private warnThrottled(event: string, error: unknown): void {
    const at = this.now().getTime();
    if (at - this.lastDroppedLogAt < LOG_INTERVAL_MS) return;
    this.lastDroppedLogAt = at;
    this.logger.warn(JSON.stringify({ module: "name-rules", event, reason: errorName(error) }));
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
