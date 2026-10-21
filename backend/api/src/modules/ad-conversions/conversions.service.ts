import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { Outbound } from "../../infra/outbound/outbound.js";
import { REDIS } from "../../infra/redis.js";
import { POSTBACK_TIMEOUT_MS, SEND_BATCH, retryAt, verdictOf } from "./conversion-rules.js";
import { CONVERSIONS_REPOSITORY, type ConversionsRepository, type DueConversion } from "./conversions.repository.js";
import { POSTBACK_DESTINATIONS, UNKNOWN_DESTINATION_REASON, type DestinationKind, type PostbackDestination, type Prepared } from "./destinations/destination.js";

/**
 * Отправка конверсий назначениям (docs/35-stage4-plan.md Р86, WP43; слой
 * «событие → назначение» — tasks/T-0069). Раз в минуту под локом Redis одна
 * реплика: дописывает конверсии из фактов (`conversions.repository.ts`),
 * отправляет созревшие и обнуляет макросы кликов старше окна.
 *
 * Что и куда отправлять, знает назначение (`destinations/`): сервис лишь
 * просит его подготовить запрос и сам отправляет — со сроком, повторами и
 * записью в журнал. Секреты назначение читает в момент подготовки: заданный
 * в панели работает со следующего прохода. Нет настройки — конверсия ждёт, а
 * не теряется.
 */

const TICK_MS = 60_000;
const LOCK_KEY = "ad-conversions:lock";
/** Худший проход: сотня отправок по пять секунд и база — с запасом. */
const LOCK_TTL_MS = 9 * 60_000;
const DB_TIMEOUT_MS = 10_000;
const PURGE_BATCH = 500;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export interface TickReport {
  registrations: number;
  purchases: number;
  sent: number;
  failed: number;
  deferred: number;
  skipped: number;
  purged: number;
}

type Outcome = "sent" | "failed" | "deferred" | "skipped";

@Injectable()
export class AdConversionsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("ad-conversions");
  private readonly destinations = new Map<DestinationKind, PostbackDestination>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CONVERSIONS_REPOSITORY) private readonly repository: ConversionsRepository,
    @Inject(POSTBACK_DESTINATIONS) destinations: readonly PostbackDestination[],
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "eval">,
    // Без модуля клиента (тесты) постбэки идут глобальным fetch.
    @Optional() private readonly outbound?: Outbound,
  ) {
    for (const destination of destinations) {
      // Два назначения одного вида взяли бы конверсию любое из двух.
      if (this.destinations.has(destination.kind)) throw new Error(`Назначение постбэков ${destination.kind} подключено дважды`);
      this.destinations.set(destination.kind, destination);
    }
  }

  onApplicationBootstrap(): void {
    if (this.config.databaseUrl === "") return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** Один проход; `null` — не запускался: идёт предыдущий или лок у другой реплики. */
  async tick(now = new Date(), fetchImpl?: typeof fetch): Promise<TickReport | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const token = randomUUID();
      const claimed = await this.redis.set(LOCK_KEY, token, "PX", LOCK_TTL_MS, "NX");
      if (claimed === null) return null;
      try {
        const report = await this.pass(now, fetchImpl ?? this.outbound?.forService("ads.postback") ?? fetch);
        if (Object.values(report).some((count) => count > 0)) this.log("log", "pass", { ...report });
        return report;
      } finally {
        await this.redis.eval(RELEASE_SCRIPT, 1, LOCK_KEY, token);
      }
    } catch (error: unknown) {
      this.log("warn", "pass_failed", { reason: reasonOf(error) });
      return null;
    } finally {
      this.running = false;
    }
  }

  private async pass(now: Date, fetchImpl: typeof fetch): Promise<TickReport> {
    const found = await withTimeout(this.repository.sweep(now), DB_TIMEOUT_MS, "поиск конверсий");
    const report: TickReport = { ...found, sent: 0, failed: 0, deferred: 0, skipped: 0, purged: 0 };
    const due = await withTimeout(this.repository.due(now, SEND_BATCH), DB_TIMEOUT_MS, "очередь конверсий");
    for (const conversion of due) {
      const outcome = await this.send(conversion, now, fetchImpl);
      report[outcome] += 1;
    }
    report.purged = await withTimeout(this.repository.purgeParams(now, PURGE_BATCH), DB_TIMEOUT_MS, "обнуление макросов");
    return report;
  }

  private async send(conversion: DueConversion, now: Date, fetchImpl: typeof fetch): Promise<Outcome> {
    const destination = this.destinations.get(conversion.destination);
    if (destination === undefined || !destination.accepts.includes(conversion.event)) {
      await this.repository.skip(conversion.conversionId, UNKNOWN_DESTINATION_REASON);
      return "skipped";
    }

    let prepared: Prepared;
    try {
      prepared = await destination.prepare(conversion);
    } catch (error: unknown) {
      // Упавшее назначение не должно останавливать очередь: конверсия повторится по расписанию.
      const outcome = await this.fail(conversion, now, true, null, `назначение не подготовило запрос: ${reasonOf(error)}`);
      this.log("warn", "postback_prepare_failed", { conversionId: conversion.conversionId, destination: conversion.destination, reason: reasonOf(error), retry: outcome === "deferred" });
      return outcome;
    }

    switch (prepared.kind) {
      case "wait":
        await this.repository.defer(conversion.conversionId, new Date(now.getTime() + prepared.recheckMin * 60_000), prepared.reason);
        return "deferred";
      case "skip":
        await this.repository.skip(conversion.conversionId, prepared.reason);
        return "skipped";
      case "fail": {
        const outcome = await this.fail(conversion, now, prepared.retry, null, prepared.message);
        this.log("warn", "postback_not_sent", { conversionId: conversion.conversionId, destination: conversion.destination, reason: prepared.message, retry: outcome === "deferred" });
        return outcome;
      }
      case "request":
        return await this.deliver(conversion, prepared, now, fetchImpl);
    }
  }

  /** Отправить готовый запрос и записать исход: ответ сети, сбой или таймаут. В лог — только `logUrl`. */
  private async deliver(conversion: DueConversion, prepared: Extract<Prepared, { kind: "request" }>, now: Date, fetchImpl: typeof fetch): Promise<Outcome> {
    const timeout = AbortSignal.timeout(POSTBACK_TIMEOUT_MS);
    const own = prepared.init?.signal;
    let response: Response;
    try {
      response = await fetchImpl(prepared.url, { ...prepared.init, signal: own === undefined || own === null ? timeout : AbortSignal.any([own, timeout]) });
    } catch (error: unknown) {
      const isTimeout = error instanceof Error && error.name === "TimeoutError";
      const outcome = await this.fail(conversion, now, true, null, isTimeout ? "сеть не ответила за 5 секунд" : `сеть недоступна: ${reasonOf(error)}`);
      this.log("warn", "postback_failed", { conversionId: conversion.conversionId, destination: conversion.destination, url: prepared.logUrl, reason: reasonOf(error), retry: outcome === "deferred" });
      return outcome;
    }

    const verdict = verdictOf(response.status);
    if (verdict === "sent") {
      await this.repository.markSent(conversion.conversionId, response.status, now);
      return "sent";
    }
    const body = (await response.text().catch(() => "")).slice(0, 160);
    const outcome = await this.fail(conversion, now, verdict === "retry", response.status, `ответ ${String(response.status)}${body === "" ? "" : `: ${body}`}`);
    this.log("warn", "postback_rejected", { conversionId: conversion.conversionId, destination: conversion.destination, status: response.status, url: prepared.logUrl, retry: outcome === "deferred" });
    return outcome;
  }

  /** Попытка не удалась: повторить по расписанию (`retry`) или сразу «не отправлена», когда повторов нет или они кончились. */
  private async fail(conversion: DueConversion, now: Date, retry: boolean, httpStatus: number | null, message: string): Promise<"failed" | "deferred"> {
    const attempts = conversion.attempts + 1;
    const nextAt = retry ? retryAt(attempts, now) : null;
    await this.repository.markFailed(conversion.conversionId, attempts, nextAt, httpStatus, message);
    return nextAt === null ? "failed" : "deferred";
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "ad-conversions", event, ...fields }));
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
