import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { withTimeout } from "../../common/with-timeout.js";
import { createQueueConnection } from "../../infra/queues.js";
import { AuthHooks, type LoginEvent } from "../auth/auth-hooks.js";
import { AutoSourcesService } from "../links/auto-sources.service.js";
import { PartnerLinkBinder } from "../partners/partner-links.js";
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
 *
 * Сессия по ссылке или клику — ещё и повод записать игрока за партнёром
 * (docs/23-referral-and-partner-program.md §5, T-0067): сразу после записи
 * сессии. Сбой привязки сессию не откатывает: сессия уже записана, а
 * задание очереди падает и повторяется; повтор записи сессии — безвредный
 * дубль, так что на деле повторяется одна привязка.
 *
 * Ссылка с метками (`src-…_cmp-…`, Р116) ещё и заводит источник — тоже сразу после записи сессии
 * и только за настоящую запись: повтор задания очереди («duplicate») источники и счётчики не двигает.
 * Сбой источника сессию не откатывает и задание не роняет: источник заведёт следующий игрок.
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

/**
 * Привязка партнёру не удалась, а сессия записана. Своя ошибка нужна, чтобы журнал сбоев задания не
 * называл это потерей сессии.
 */
export class PartnerBindFailed extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "PartnerBindFailed";
  }
}

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
    // Побочная запись: без неё (записи сессий в тестах) сессия пишется, как до ссылок партнёров.
    @Optional() @Inject(PartnerLinkBinder) private readonly partnerLinks: PartnerLinkBinder | null = null,
    // Побочная запись, как и привязка: без модуля ссылок сессии пишутся, а источники не заводятся.
    @Optional() @Inject(AutoSourcesService) private readonly autoSources: AutoSourcesService | null = null,
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
    this.worker.on("failed", (job, error) => this.logJobFailure(job?.data.session, job?.attemptsMade ?? 0, error));
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
    let written: "recorded" | "duplicate";
    try {
      written = await this.sessions.record(session);
    } catch (error: unknown) {
      this.log("warn", "session_lost", { accountId: session.accountId, startKind: session.startKind, reason: reasonOf(error) });
      return;
    }
    if (written === "recorded") await this.noteAutoSource(session);
    // Очереди нет — повторять некому: сбой привязки только в лог, вход он не держит.
    try {
      await this.bindToPartner(session);
    } catch (error: unknown) {
      this.log("warn", "partner_bind_failed", { accountId: session.accountId, reason: reasonOf(error) });
    }
  }

  /**
   * Одно задание. Вынесено ради тестов: очередь вокруг — BullMQ. Повтор задания после сбоя привязки
   * записывает сессию ещё раз (это дубль, не ошибка) и довозит привязку.
   */
  async process(job: Pick<Job<{ session: SessionRecord }>, "data">): Promise<void> {
    const written = await this.sessions.record(job.data.session);
    // Источник — до привязки: упавшая привязка повторит задание, а повтор («duplicate») источник уже не заведёт.
    if (written === "recorded") await this.noteAutoSource(job.data.session);
    await this.bindToPartner(job.data.session);
  }

  /** Сбой задания — строкой лога: упавшая привязка называется своим именем, а не потерей сессии. */
  logJobFailure(session: SessionRecord | undefined, attempts: number, error: Error): void {
    if (error instanceof PartnerBindFailed) {
      this.log("warn", "partner_bind_failed", { accountId: session?.accountId, attempts, reason: error.message });
      return;
    }
    this.log("warn", "session_write_failed", { sessionId: session?.sessionId, attempts, reason: error.message });
  }

  /**
   * Касание по клику или прямой ссылке может привести игрока к партнёру. Остальные виды запуска
   * ссылок партнёров не несут. Сбой — `PartnerBindFailed`: сессия уже записана, пробовать надо
   * только привязку.
   */
  private async bindToPartner(session: SessionRecord): Promise<void> {
    if (this.partnerLinks === null) return;
    if (session.startKind !== "click" && session.startKind !== "link") return;
    try {
      await this.partnerLinks.bindFromTouch({ accountId: session.accountId, startKind: session.startKind, startRef: session.startRef, at: new Date(session.startedAt) });
    } catch (error: unknown) {
      throw new PartnerBindFailed(reasonOf(error), { cause: error });
    }
  }

  /**
   * Ссылка с метками заводит источник, незнакомые ключи идут в сводку. Решает сервис ссылок: какие
   * сессии ему интересны, рекордер не знает. В лог — только вид ошибки: сообщение Prisma несёт
   * значения запроса, а значения пар вписывает кто угодно.
   */
  private async noteAutoSource(session: SessionRecord): Promise<void> {
    if (this.autoSources === null) return;
    try {
      await this.autoSources.onSession({ startParam: session.startParam, platform: session.platform, startedAt: session.startedAt });
    } catch (error: unknown) {
      this.log("warn", "auto_source_failed", { accountId: session.accountId, error: errorKind(error) });
    }
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

function errorKind(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? `${error.name}:${code}` : error.name;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
