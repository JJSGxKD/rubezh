import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { SECRETS } from "../secrets/secret-catalog.js";
import { SECRETS_READER, type SecretsReader } from "../secrets/secrets.service.js";
import { NO_TOKEN_RECHECK_MIN, POSTBACK_TIMEOUT_MS, SEND_BATCH, adsgramPostbackUrl, redacted, retryAt, verdictOf } from "./conversion-rules.js";
import { CONVERSIONS_REPOSITORY, type ConversionsRepository, type DueConversion } from "./conversions.repository.js";

/**
 * Отправка конверсий в сети, где куплена реклама (docs/35-stage4-plan.md
 * Р86, WP43). Раз в минуту под локом Redis одна реплика: дописывает
 * конверсии из фактов (`conversions.repository.ts`), отправляет созревшие и
 * обнуляет макросы кликов старше окна.
 *
 * Токен кабинета берётся в момент отправки: заданный в панели работает со
 * следующего прохода. Нет токена — конверсия ждёт, а не теряется.
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

@Injectable()
export class AdConversionsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("ad-conversions");
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CONVERSIONS_REPOSITORY) private readonly repository: ConversionsRepository,
    @Inject(SECRETS_READER) private readonly secrets: SecretsReader,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "eval">,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.databaseUrl === "") return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** Один проход; `null` — не запускался: идёт предыдущий или лок у другой реплики. */
  async tick(now = new Date(), fetchImpl: typeof fetch = fetch): Promise<TickReport | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const token = randomUUID();
      const claimed = await this.redis.set(LOCK_KEY, token, "PX", LOCK_TTL_MS, "NX");
      if (claimed === null) return null;
      try {
        const report = await this.pass(now, fetchImpl);
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

  private async send(conversion: DueConversion, now: Date, fetchImpl: typeof fetch): Promise<"sent" | "failed" | "deferred" | "skipped"> {
    if (conversion.network !== "adsgram") {
      await this.repository.skip(conversion.conversionId, "unknown_network");
      return "skipped";
    }
    const token = this.secrets.get(SECRETS.adsgramConversionToken);
    if (token === null) {
      await this.repository.defer(conversion.conversionId, new Date(now.getTime() + NO_TOKEN_RECHECK_MIN * 60_000), "no_token");
      return "deferred";
    }
    const url = adsgramPostbackUrl(token, conversion);
    if (url === null) {
      await this.repository.skip(conversion.conversionId, "no_macros");
      return "skipped";
    }

    const attempts = conversion.attempts + 1;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(POSTBACK_TIMEOUT_MS) });
      const verdict = verdictOf(response.status);
      if (verdict === "sent") {
        await this.repository.markSent(conversion.conversionId, response.status, now);
        return "sent";
      }
      const body = (await response.text().catch(() => "")).slice(0, 160);
      const nextAt = verdict === "retry" ? retryAt(attempts, now) : null;
      await this.repository.markFailed(conversion.conversionId, attempts, nextAt, response.status, `ответ ${String(response.status)}${body === "" ? "" : `: ${body}`}`);
      this.log("warn", "postback_rejected", { conversionId: conversion.conversionId, status: response.status, url: redacted(url), retry: nextAt !== null });
      return nextAt === null ? "failed" : "deferred";
    } catch (error: unknown) {
      const timeout = error instanceof Error && error.name === "TimeoutError";
      const nextAt = retryAt(attempts, now);
      await this.repository.markFailed(conversion.conversionId, attempts, nextAt, null, timeout ? "сеть не ответила за 5 секунд" : `сеть недоступна: ${reasonOf(error)}`);
      this.log("warn", "postback_failed", { conversionId: conversion.conversionId, url: redacted(url), reason: reasonOf(error), retry: nextAt !== null });
      return nextAt === null ? "failed" : "deferred";
    }
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "ad-conversions", event, ...fields }));
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
