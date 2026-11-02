import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { createQueueConnection } from "../../infra/queues.js";
import { ALL_TIME_REPOSITORY, type ActivitySnapshotRepository } from "../admin/admin-all-time.repository.js";
import { daysToClose, SNAPSHOT_CRON, SNAPSHOT_TIME_ZONE, windowOf } from "./activity-snapshot.js";

/**
 * Ночной снимок аудитории (tasks/T-0203): раз в сутки в 00:20 по Москве —
 * после отчёта в 00:10 — закрывает все сутки от последней записи до вчерашних
 * и кладёт в `activity_daily` DAU, WAU и MAU. Из этой таблицы берутся рекорды
 * панели «Чего достигли»; считать скользящие окна по всей истории сессий при
 * каждом открытии панели нельзя.
 *
 * Одно задание на тик на все реплики — постоянный id планировщика BullMQ и
 * `concurrency: 1`, это и есть распределённый лок. Если же задания всё-таки
 * пересеклись, ничего страшного: сутки закрываются в порядке очереди,
 * повторная запись отклоняется (`ON CONFLICT DO NOTHING`), а те же сутки
 * дают те же числа.
 *
 * Пустая таблица или отставание больше суток при старте API — повод догнать
 * сразу, не дожидаясь ночи: бэкфилл строит историю из сессий запуска, которые
 * вайп не стирает. Он идёт заданием очереди с постоянным id, а не в
 * `onApplicationBootstrap`: старт API не ждёт часов запросов, и несколько
 * реплик, поднятых вместе, заводят одно задание, а не по одному.
 */

const QUEUE_NAME = "activity-snapshot";
const SCHEDULER_ID = "activity-snapshot";
const CATCH_UP_ID = "activity-snapshot-catch-up";
const DB_TIMEOUT_MS = 20_000;

@Injectable()
export class ActivitySnapshotJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("admin-notify");
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ALL_TIME_REPOSITORY) private readonly repository: ActivitySnapshotRepository,
  ) {}

  /** Включено там же, где остальные задания: нужна база, которой живёт приложение. */
  get enabled(): boolean {
    return this.config.databaseUrl !== "";
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(QUEUE_NAME, { connection: producer });
    this.worker = new Worker(QUEUE_NAME, async () => void (await this.closeDays(new Date())), { connection: consumer, concurrency: 1 });
    this.worker.on("failed", (_job, error) => this.log("warn", "activity_snapshot_failed", { reason: error.message }));
    this.worker.on("error", (error) => this.log("warn", "activity_snapshot_worker_error", { reason: error.message }));
    try {
      // Планировщик с тем же id идемпотентен: перезапуск и соседние реплики не заводят второе расписание.
      await this.queue.upsertJobScheduler(SCHEDULER_ID, { pattern: SNAPSHOT_CRON, tz: SNAPSHOT_TIME_ZONE }, { name: "snapshot", opts: { attempts: 1, removeOnComplete: 10, removeOnFail: 10 } });
      if (await this.lagging(new Date())) {
        // Постоянный id: пока задание ждёт или идёт, второе не заводится; готовое снимается, чтобы id можно было занять снова.
        await this.queue.add("catch-up", {}, { jobId: CATCH_UP_ID, attempts: 1, removeOnComplete: true, removeOnFail: true });
      }
    } catch (error: unknown) {
      this.log("warn", "activity_snapshot_schedule_failed", { reason: error instanceof Error ? error.message : "unknown" });
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }

  /**
   * Пусто или не хватает больше одних суток. Вчерашних до задания в 00:20 не
   * хватает всегда — это не отставание.
   */
  async lagging(now: Date): Promise<boolean> {
    const { lastClosed, days } = await this.pending(now);
    return lastClosed === null ? days.length > 0 : days.length > 1;
  }

  /**
   * Один проход: закрыть сутки по порядку. Сбой на сутках останавливает проход:
   * последующие окна пересеклись бы с дырой, а следующий проход продолжит с
   * упавших. Возвращает, сколько суток записал этот проход.
   */
  async closeDays(now: Date): Promise<number> {
    const { days } = await this.pending(now);
    let closed = 0;
    for (const day of days) {
      try {
        const [dau, wau, mau] = [await this.active(day, 1), await this.active(day, 7), await this.active(day, 30)];
        if (await withTimeout(this.repository.insertDay(day, dau, wau, mau), DB_TIMEOUT_MS, `снимок аудитории: запись ${day}`)) closed++;
      } catch (error: unknown) {
        this.log("warn", "activity_snapshot_failed", { day, reason: error instanceof Error ? error.message : "unknown" });
        break;
      }
    }
    this.log("log", "activity_snapshot_done", { closed });
    return closed;
  }

  private async pending(now: Date): Promise<{ lastClosed: string | null; days: string[] }> {
    const lastClosed = await withTimeout(this.repository.lastClosedDay(), DB_TIMEOUT_MS, "снимок аудитории: последние сутки");
    // Первая сессия нужна только пустой таблице: дальше начало задаёт последняя запись.
    const first = lastClosed === null ? await withTimeout(this.repository.firstSessionAt(), DB_TIMEOUT_MS, "снимок аудитории: первая сессия") : null;
    return { lastClosed, days: daysToClose(lastClosed, first, now) };
  }

  private async active(day: string, length: 1 | 7 | 30): Promise<number> {
    return await withTimeout(this.repository.activeIn(windowOf(day, length)), DB_TIMEOUT_MS, `снимок аудитории: окно ${String(length)} за ${day}`);
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "admin-notify", event, ...fields }));
  }
}
