import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { OutboundRecord, OutboundSink } from "../../infra/outbound/outbound.js";
import { FLUSH_ATTEMPTS, JOURNAL_CLOCK, OUTBOUND_BUFFER_MAX, OUTBOUND_FLUSH_MS, WARN_EVERY_MS } from "./journal-rules.js";
import { REQUEST_JOURNAL_REPOSITORY, type RequestJournalRepository } from "./request-journal.repository.js";

/**
 * Приёмник клиента исходящих запросов с буфером (docs/35-stage4-plan.md Р92,
 * tasks/T-0060): запись — в память, раз в 5 секунд буфер уходит в базу одной
 * вставкой. Вызов, который записывается, базу не ждёт и от неё не зависит.
 *
 * Буфер не больше 2000 записей: лишние отбрасываются со счётчиком и
 * предупреждением раз в минуту. Журнал — наблюдение, а не учёт: потерять часть
 * строк при всплеске лучше, чем притормозить вызов.
 */
@Injectable()
export class BufferedOutboundSink implements OutboundSink, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("request-journal");
  private readonly now: () => number;
  private buffer: OutboundRecord[] = [];
  private droppedTotal = 0;
  private droppedSinceWarn = 0;
  private failedFlushes = 0;
  private inflight: Promise<number> | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** когда каждое событие в последний раз попало в лог */
  private readonly lastWarnAt = new Map<string, number>();

  constructor(
    @Inject(REQUEST_JOURNAL_REPOSITORY) private readonly store: Pick<RequestJournalRepository, "insertOutboundCalls">,
    @Optional() @Inject(JOURNAL_CLOCK) now?: () => number,
  ) {
    this.now = now ?? (() => Date.now());
  }

  /** Сколько записей ждёт сброса. */
  get size(): number {
    return this.buffer.length;
  }

  /** Сколько записей отброшено за время работы процесса: буфер был полон или база не принимала пачку. */
  get dropped(): number {
    return this.droppedTotal;
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), OUTBOUND_FLUSH_MS);
    this.timer.unref();
  }

  /** При остановке процесса буфер уходит в базу: база отключается позже, на `onApplicationShutdown`. */
  async onModuleDestroy(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    // Второй заход — на записи, которые легли, пока шёл первый сброс.
    for (let attempt = 0; attempt < 2 && (this.inflight !== null || this.buffer.length > 0); attempt += 1) await this.flush();
  }

  write(record: OutboundRecord): void {
    if (this.buffer.length >= OUTBOUND_BUFFER_MAX) {
      this.drop(1);
      return;
    }
    this.buffer.push(record);
  }

  /** Сбрасывает буфер в базу одной пачкой; сколько записей записано. Не бросает: сбой — в лог, пачка остаётся. */
  flush(): Promise<number> {
    if (this.inflight !== null) return this.inflight;
    if (this.buffer.length === 0) return Promise.resolve(0);
    const run = this.send().finally(() => {
      this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  private async send(): Promise<number> {
    // Буфер забирается сразу: записи, что лягут за время вставки, пойдут со следующей пачкой.
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.store.insertOutboundCalls(batch);
      this.failedFlushes = 0;
      return batch.length;
    } catch (error: unknown) {
      this.failedFlushes += 1;
      this.warnLimited("outbound_flush_failed", { reason: error instanceof Error ? error.message : "unknown", pending: batch.length });
      // Пачка, которую база не принимает раз за разом, не должна копиться вечно.
      if (this.failedFlushes >= FLUSH_ATTEMPTS) {
        this.failedFlushes = 0;
        this.drop(batch.length);
        return 0;
      }
      const room = Math.max(OUTBOUND_BUFFER_MAX - this.buffer.length, 0);
      this.buffer = [...batch.slice(0, room), ...this.buffer];
      if (batch.length > room) this.drop(batch.length - room);
      return 0;
    }
  }

  private drop(count: number): void {
    this.droppedTotal += count;
    this.droppedSinceWarn += count;
    if (this.warnLimited("outbound_dropped", { dropped: this.droppedSinceWarn, total: this.droppedTotal })) this.droppedSinceWarn = 0;
  }

  /** Предупреждение не чаще раза в минуту на событие; записано ли оно. */
  private warnLimited(event: string, details: Record<string, unknown>): boolean {
    const at = this.now();
    const last = this.lastWarnAt.get(event);
    if (last !== undefined && at - last < WARN_EVERY_MS) return false;
    this.lastWarnAt.set(event, at);
    this.logger.warn(JSON.stringify({ module: "request-journal", event, ...details }));
    return true;
  }
}
