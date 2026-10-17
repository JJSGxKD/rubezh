import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { z } from "zod";
import { REDIS } from "../../infra/redis.js";
import { PLATFORM_IDS, type PlatformId } from "../../platforms/ports/platform.js";

/**
 * Онлайн в Redis (Р107, docs/35-stage4-plan.md): «в приложении» и «в
 * забеге» — отсортированные множества «аккаунт → время последней отметки»
 * по площадкам, «сегодня играли» — HyperLogLog на игровые сутки.
 * Устаревшие отметки выбрасывает пересчёт, а не чтение: чтение остаётся
 * одним `GET` готового JSON, сколько бы игроков ни спрашивало.
 *
 * Каждая команда идёт с таймаутом клиента (`infra/redis.ts`).
 */

export interface PlatformCounts {
  app: number;
  run: number;
  today: number;
}

export interface OnlineCounts {
  byPlatform: Record<PlatformId, PlatformCounts>;
  total: PlatformCounts;
  /** момент пересчёта, мс */
  at: number;
}

export interface OnlinePeak {
  value: number;
  /** момент пересчёта, на котором рекорд поставлен, мс */
  at: number;
}

export interface OnlineRepository {
  touch(accountId: string, platform: PlatformId, nowMs: number, gameDay: string): Promise<void>;
  setInRun(accountId: string, platform: PlatformId, inRun: boolean, nowMs: number): Promise<void>;
  recount(nowMs: number, windowMs: number, gameDay: string): Promise<OnlineCounts>;
  counts(): Promise<OnlineCounts | null>;
  peak(): Promise<OnlinePeak | null>;
  setPeak(value: number, atMs: number): Promise<void>;
}

export const ONLINE_REPOSITORY = Symbol("ONLINE_REPOSITORY");

/** Ключи дневных HyperLogLog живут двое суток: сутки на запись и сутки на вчерашние цифры панели. */
const DAY_KEY_TTL_SEC = 172_800;

const COUNTS_KEY = "online:counts";
const PEAK_KEY = "online:peak";

const appKey = (platform: PlatformId): string => `online:app:${platform}`;
const runKey = (platform: PlatformId): string => `online:run:${platform}`;
const dayKey = (gameDay: string): string => `online:day:${gameDay}`;
const dayPlatformKey = (gameDay: string, platform: PlatformId): string => `online:day:${gameDay}:${platform}`;

const count = z.number().int().nonnegative();
const platformCountsSchema = z.object({ app: count, run: count, today: count });
const countsSchema = z.object({
  byPlatform: z.object({
    telegram: platformCountsSchema,
    max: platformCountsSchema,
    vk: platformCountsSchema,
    web: platformCountsSchema,
  }),
  total: platformCountsSchema,
  at: z.number().int().nonnegative(),
});
const peakSchema = z.object({ value: count, at: z.number().int().nonnegative() });

/** Ответ конвейера Redis: ошибку любой команды поднимаем, а не читаем как ноль. */
function replies(result: [Error | null, unknown][] | null): unknown[] {
  if (result === null) throw new Error("Redis не вернул ответ конвейера");
  return result.map(([error, value]) => {
    if (error !== null) throw error;
    return value;
  });
}

function readJson<T>(raw: string | null, schema: z.ZodType<T>): T | null {
  if (raw === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    // Битое значение — «чисел нет»: ближайший пересчёт его заменит.
    return null;
  }
}

@Injectable()
export class RedisOnlineRepository implements OnlineRepository {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async touch(accountId: string, platform: PlatformId, nowMs: number, gameDay: string): Promise<void> {
    const total = dayKey(gameDay);
    const byPlatform = dayPlatformKey(gameDay, platform);
    replies(
      await this.redis
        .pipeline()
        .zadd(appKey(platform), nowMs, accountId)
        .pfadd(total, accountId)
        .pfadd(byPlatform, accountId)
        .expire(total, DAY_KEY_TTL_SEC)
        .expire(byPlatform, DAY_KEY_TTL_SEC)
        .exec(),
    );
  }

  async setInRun(accountId: string, platform: PlatformId, inRun: boolean, nowMs: number): Promise<void> {
    if (inRun) await this.redis.zadd(runKey(platform), nowMs, accountId);
    else await this.redis.zrem(runKey(platform), accountId);
  }

  async recount(nowMs: number, windowMs: number, gameDay: string): Promise<OnlineCounts> {
    const cutoff = `(${String(nowMs - windowMs)}`;
    const pipeline = this.redis.pipeline();
    for (const platform of PLATFORM_IDS) {
      pipeline
        .zremrangebyscore(appKey(platform), "-inf", cutoff)
        .zremrangebyscore(runKey(platform), "-inf", cutoff)
        .zcard(appKey(platform))
        .zcard(runKey(platform))
        .pfcount(dayPlatformKey(gameDay, platform));
    }
    pipeline.pfcount(dayKey(gameDay));
    const answers = replies(await pipeline.exec());

    const byPlatform = {} as Record<PlatformId, PlatformCounts>;
    const total: PlatformCounts = { app: 0, run: 0, today: Number(answers[answers.length - 1]) };
    PLATFORM_IDS.forEach((platform, index) => {
      const base = index * 5;
      const counts = { app: Number(answers[base + 2]), run: Number(answers[base + 3]), today: Number(answers[base + 4]) };
      byPlatform[platform] = counts;
      // Аккаунт живёт на одной площадке, поэтому множества не пересекаются и складываются;
      // «сегодня» складывать нельзя — HyperLogLog суммарного ключа считает объединение сам.
      total.app += counts.app;
      total.run += counts.run;
    });

    const result: OnlineCounts = { byPlatform, total, at: nowMs };
    await this.redis.set(COUNTS_KEY, JSON.stringify(result));
    return result;
  }

  async counts(): Promise<OnlineCounts | null> {
    return readJson(await this.redis.get(COUNTS_KEY), countsSchema);
  }

  async peak(): Promise<OnlinePeak | null> {
    return readJson(await this.redis.get(PEAK_KEY), peakSchema);
  }

  async setPeak(value: number, atMs: number): Promise<void> {
    await this.redis.set(PEAK_KEY, JSON.stringify({ value, at: atMs }));
  }
}
