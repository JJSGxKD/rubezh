import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { Redis } from "ioredis";
import { z } from "zod";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import {
  BUCKET_COUNT,
  CLEANUP_BATCH,
  INBOUND_KEY_TTL_SEC,
  JOURNAL_KEEP_DAYS,
  ROLLUP_GRACE_MS,
  ROLLUP_TICK_MS,
  minuteKey,
  parseInboundField,
} from "./journal-rules.js";
import { REQUEST_JOURNAL_REPOSITORY, type InboundMinuteRow, type RequestJournalRepository } from "./request-journal.repository.js";

/**
 * Перенос сводки входящих из Redis в Postgres и уборка (docs/35-stage4-plan.md
 * Р92, tasks/T-0060). Раз в минуту, под распределённым локом: при нескольких
 * репликах API переносит одна.
 *
 * Перенос: прошедшие минуты читаются из Redis одной пачкой, каждая записывается
 * в `inbound_minute` с прибавлением, после чего её ключ удаляется. Повтор не
 * задваивает: ключа уже нет, а запоздавшая запись в давнюю минуту прибавится
 * отдельной порцией. Сбой базы оставляет ключ, и следующий проход перенесёт его
 * снова; если процесс упадёт между записью и удалением, минута один раз
 * посчитается дважды — для наблюдения это приемлемо.
 *
 * Уборка раз в сутки: метка в Redis с суточным сроком жизни. Не дочистили или
 * сбой — метка снимается, и уборка продолжится со следующей минуты.
 */

const LOCK_KEY = "request-journal:lock";
const CLEANUP_KEY = "request-journal:cleanup";
/** Срок лока — худший проход: перенос и бюджет уборки. */
const LOCK_TTL_MS = 90_000;
const DAY_SEC = 24 * 3600;
const DAY_MS = DAY_SEC * 1000;
/** Сколько работает уборка за один проход; недоделанное доделывает следующий. */
const CLEANUP_BUDGET_MS = 45_000;
/** Сколько минут назад перебираются ключи: ровно срок их жизни в Redis. */
const LOOKBACK_MINUTES = INBOUND_KEY_TTL_SEC / 60;
/** Хеш минуты: поле — значение строкой. */
const HASH_SCHEMA = z.record(z.string(), z.string());

/** Снимается лок только своим токеном — проход, переживший свой лок, не снимет чужой. */
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export interface CleanupReport {
  outbound: number;
  inbound: number;
  /** `false`, если бюджет времени кончился раньше, чем строки старше границы */
  complete: boolean;
}

export interface RollupReport {
  /** сколько минут перенесено в базу */
  rolled: number;
  /** итог уборки; `null` — сегодня она уже была или не вышла */
  cleaned: CleanupReport | null;
}

@Injectable()
export class JournalRollup implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("request-journal");
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(REDIS) private readonly redis: Pick<Redis, "pipeline" | "del" | "set" | "eval">,
    @Inject(REQUEST_JOURNAL_REPOSITORY) private readonly store: RequestJournalRepository,
    // Без настроек (модуль собран в тесте руками) задание считается включённым.
    @Optional() @Inject(APP_CONFIG) private readonly config?: AppConfig,
  ) {}

  /** Без базы переносить некуда — как у остальных заданий. */
  private get enabled(): boolean {
    return this.config === undefined || this.config.databaseUrl !== "";
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.tick(), ROLLUP_TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** Один проход; `null` — не запускался: идёт предыдущий, лок у другой реплики или Redis недоступен. */
  async tick(now = new Date()): Promise<RollupReport | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const token = randomUUID();
      const claimed = await this.redis.set(LOCK_KEY, token, "PX", LOCK_TTL_MS, "NX");
      if (claimed === null) return null;
      try {
        const rolled = await this.rollInbound(now);
        const cleaned = await this.dailyCleanup(now);
        return { rolled, cleaned };
      } finally {
        // Не снялся — лок истечёт сам через 90 секунд, а сделанная работа не пропадает.
        await this.redis.eval(RELEASE_SCRIPT, 1, LOCK_KEY, token).catch(() => undefined);
      }
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "request-journal", event: "rollup_failed", reason: error instanceof Error ? error.message : "unknown" }));
      return null;
    } finally {
      this.running = false;
    }
  }

  /** Переносит прошедшие минуты в базу; сколько минут перенесено. Ошибка Redis бросается, ошибка базы — нет. */
  async rollInbound(now: Date): Promise<number> {
    const minutes = pastMinutes(now);
    const pipeline = this.redis.pipeline();
    for (const minute of minutes) pipeline.hgetall(minuteKey(minute));
    const results = await pipeline.exec();
    if (results === null) return 0;

    let rolled = 0;
    // От давних к свежим: давние ближе к концу срока жизни ключа.
    for (let index = minutes.length - 1; index >= 0; index -= 1) {
      const minute = minutes[index];
      const [error, hash] = results[index] ?? [null, null];
      if (minute === undefined) continue;
      if (error !== null) throw error;
      // Ответ Redis — граница системы: разбирается схемой, а не приводится типом.
      const parsed = HASH_SCHEMA.safeParse(hash);
      if (!parsed.success || Object.keys(parsed.data).length === 0) continue;
      try {
        const rows = rowsOf(minute, parsed.data);
        if (rows.length > 0) await this.store.addInboundMinutes(rows);
        await this.redis.del(minuteKey(minute));
        rolled += 1;
      } catch (failure: unknown) {
        // Ключ остался — следующий проход попробует снова, пока он не истёк.
        // Дальше не идём: база, не принявшая эту минуту, не примет и следующие,
        // а каждая попытка ждёт соединения; лог получает одну строку на проход.
        this.logger.warn(JSON.stringify({ module: "request-journal", event: "inbound_rollup_failed", minute: minute.toISOString(), reason: failure instanceof Error ? failure.message : "unknown" }));
        break;
      }
    }
    return rolled;
  }

  /** Удаляет строки старше `JOURNAL_KEEP_DAYS` пачками, пока пачка полная или не кончился бюджет времени. */
  async cleanup(now: Date, batch = CLEANUP_BATCH): Promise<CleanupReport> {
    const cutoff = new Date(now.getTime() - JOURNAL_KEEP_DAYS * DAY_MS);
    const deadline = Date.now() + CLEANUP_BUDGET_MS;
    const outbound = await sweep((limit) => this.store.deleteOutboundBefore(cutoff, limit), batch, deadline);
    const inbound = await sweep((limit) => this.store.deleteInboundBefore(cutoff, limit), batch, deadline);
    return { outbound: outbound.deleted, inbound: inbound.deleted, complete: outbound.complete && inbound.complete };
  }

  private async dailyCleanup(now: Date): Promise<CleanupReport | null> {
    const claimed = await this.redis.set(CLEANUP_KEY, "1", "EX", DAY_SEC, "NX");
    if (claimed === null) return null;
    try {
      const report = await this.cleanup(now);
      // Не дочистили за бюджет — метка снимается, остальное уберёт следующий проход.
      if (!report.complete) await this.redis.del(CLEANUP_KEY);
      return report;
    } catch (error: unknown) {
      await this.redis.del(CLEANUP_KEY).catch(() => undefined);
      this.logger.warn(JSON.stringify({ module: "request-journal", event: "cleanup_failed", reason: error instanceof Error ? error.message : "unknown" }));
      return null;
    }
  }
}

/** Пачками до неполной; хотя бы одна пачка идёт всегда, дальше — пока не вышел бюджет времени. */
async function sweep(deleteBatch: (limit: number) => Promise<number>, batch: number, deadline: number): Promise<{ deleted: number; complete: boolean }> {
  let deleted = 0;
  for (;;) {
    const removed = await deleteBatch(batch);
    deleted += removed;
    if (removed < batch) return { deleted, complete: true };
    if (Date.now() >= deadline) return { deleted, complete: false };
  }
}

/**
 * Начала минут, которые уже закончились с запасом, от свежей к давней, на срок
 * жизни ключей. Идущую минуту и минуту, у которой запас не вышел, не трогаем.
 */
function pastMinutes(now: Date): Date[] {
  const newest = Math.floor((now.getTime() - 60_000 - ROLLUP_GRACE_MS) / 60_000) * 60_000;
  return Array.from({ length: LOOKBACK_MINUTES }, (_, index) => new Date(newest - index * 60_000));
}

/**
 * Строки сводки из полей хеша минуты. Поле, которое не разбирается, или
 * значение не больше нуля — след сбоя, а не данные: пропускаются.
 */
function rowsOf(minute: Date, fields: Record<string, string>): InboundMinuteRow[] {
  const rows = new Map<string, InboundMinuteRow>();
  for (const [field, raw] of Object.entries(fields)) {
    const parsed = parseInboundField(field);
    const value = Number(raw);
    if (parsed === null || !Number.isSafeInteger(value) || value <= 0) continue;
    const id = `${parsed.method}|${parsed.statusClass}|${parsed.route}`;
    let row = rows.get(id);
    if (row === undefined) {
      row = { minute, method: parsed.method, route: parsed.route, statusClass: parsed.statusClass, count: 0, buckets: new Array<number>(BUCKET_COUNT).fill(0) };
      rows.set(id, row);
    }
    if (parsed.slot === "n") row.count += value;
    else row.buckets[parsed.slot] = (row.buckets[parsed.slot] ?? 0) + value;
  }
  for (const row of rows.values()) {
    // Число ответов потерялось, а корзины целы: общее — их сумма.
    if (row.count === 0) row.count = row.buckets.reduce((sum, value) => sum + value, 0);
  }
  return [...rows.values()].filter((row) => row.count > 0);
}
