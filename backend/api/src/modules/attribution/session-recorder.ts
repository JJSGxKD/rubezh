import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { withTimeout } from "../../common/with-timeout.js";
import { createQueueConnection } from "../../infra/queues.js";
import { AuthHooks, type LoginEvent } from "../auth/auth-hooks.js";
import { classifyClient } from "./client-class.js";
import { ipPrefix } from "./ip-prefix.js";
import { SESSION_DEDUPE, type SessionDedupe } from "./session-dedupe.js";
import { SESSIONS_REPOSITORY, type SessionRecord, type SessionsRepository } from "./sessions.repository.js";

/**
 * Сессия на каждый запуск игры (docs/34-stage3-plan.md, WP6).
 *
 * Вход её не ждёт: слушатель работает после ответа (`auth-hooks.ts`), а сама
 * запись — задание очереди. Под волной после поста в канале вход остаётся
 * быстрым, а сессии догоняют (docs/14-scalability.md §1).
 *
 * Redis недоступен — сессия пишется в базу сразу, тоже мимо ответа игроку.
 * Не записалась и так — предупреждение в лог: потерять сессию жалко, но это
 * аналитика, а не деньги, и держать ради неё вход нельзя.
 */

const QUEUE_NAME = "sessions";
const ENQUEUE_TIMEOUT_MS = 2_000;
const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2_000, jitter: 0.5 },
  removeOnComplete: 1000,
  removeOnFail: 1000,
} as const;
/** Сессия — две маленькие вставки: четырёх заданий разом хватает с запасом. */
const WORKER_CONCURRENCY = 4;

@Injectable()
export class SessionRecorder implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("attribution");
  private queue: Queue<{ session: SessionRecord }> | null = null;
  private worker: Worker<{ session: SessionRecord }> | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly hooks: AuthHooks,
    @Inject(SESSIONS_REPOSITORY) private readonly sessions: SessionsRepository,
    @Inject(SESSION_DEDUPE) private readonly dedupe: SessionDedupe,
  ) {}

  onModuleInit(): void {
    if (this.config.auth.enabled) this.hooks.onLogin("attribution", (login) => this.record(login));
  }

  onApplicationBootstrap(): void {
    if (!this.config.auth.enabled) return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(QUEUE_NAME, { connection: producer });
    this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), { connection: consumer, concurrency: WORKER_CONCURRENCY });
    this.worker.on("failed", (job, error) => {
      this.log("warn", "session_write_failed", { sessionId: job?.data.session.sessionId, attempts: job?.attemptsMade ?? 0, reason: error.message });
    });
    this.worker.on("error", (error) => this.log("warn", "worker_error", { reason: error.message }));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }

  async record(login: LoginEvent): Promise<void> {
    // Повторный вход посреди работы — та же сессия, а не новый запуск.
    if (login.reason !== "launch") return;
    if (!(await this.dedupe.claim(login.accountId, login.startParam.raw))) return;

    const session = sessionOf(login);
    if (this.queue !== null) {
      try {
        await withTimeout(this.queue.add("session", { session }, { jobId: session.sessionId, ...JOB_OPTIONS }), ENQUEUE_TIMEOUT_MS, "очередь сессий");
        return;
      } catch (error: unknown) {
        this.log("warn", "enqueue_failed", { sessionId: session.sessionId, reason: reasonOf(error) });
      }
    }
    try {
      await this.sessions.record(session);
    } catch (error: unknown) {
      this.log("warn", "session_lost", { accountId: session.accountId, startKind: session.startKind, reason: reasonOf(error) });
    }
  }

  /** Одно задание. Вынесено ради тестов: очередь вокруг — BullMQ. */
  async process(job: Pick<Job<{ session: SessionRecord }>, "data">): Promise<void> {
    await this.sessions.record(job.data.session);
  }

  private log(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "attribution", event, ...fields }));
  }
}

/** Вход — в сессию: подсказка клиента разобрана, адрес усечён до подсети. */
export function sessionOf(login: LoginEvent): SessionRecord {
  const client = classifyClient(login.client, login.userAgent);
  return {
    sessionId: randomUUID(),
    accountId: login.accountId,
    platform: login.platform,
    place: login.place,
    startKind: login.startParam.kind,
    startParam: login.startParam.raw,
    startRef: login.startParam.ref,
    clientPlatform: client.clientPlatform,
    clientVersion: client.clientVersion,
    deviceClass: client.deviceClass,
    os: client.os,
    ipPrefix: ipPrefix(login.ip),
    startedAt: login.at.toISOString(),
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
