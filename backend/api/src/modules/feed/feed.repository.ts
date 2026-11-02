import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { REDIS } from "../../infra/redis.js";
import type { Difficulty } from "../runs/run-rules.js";
import { encodeFeedEvent, feedEventSchema, type FeedEvent } from "./feed-events.js";
import { FEED_WINDOW_MS } from "./feed-rules.js";

/**
 * Хранилище ленты (tasks/T-0174). События и лидер недели — в Redis: лента —
 * витрина последних суток, пропавший ключ даёт пустую ленту, и она наполняется
 * сама, миграций нет. Имена — из Postgres, на момент сборки ответа.
 *
 * Каждая команда идёт с таймаутом: недоступный Redis или база не вешают ни
 * запись забега, ни пересчёт ответа.
 */

export interface FeedRepository {
  /** Записать события; повтор того же события не дублируется, устаревшие убираются. */
  add(events: readonly FeedEvent[], nowMs: number): Promise<void>;
  /** Свежие события от `sinceMs`, не больше `cap`; `skipped` — сколько записей не разобралось. */
  recent(sinceMs: number, cap: number): Promise<{ events: FeedEvent[]; skipped: number }>;
  /**
   * Лидер недели: `-1` — таблица пуста, значение записано; больше `0` — прежнее
   * значение, новое его обошло; `0` — не обошло.
   */
  bumpWeekTop(seasonKey: string, difficulty: Difficulty, survivalSec: number): Promise<number>;
  /** Имена тех, кто найден и не заблокирован; остальных в ответе нет. */
  namesOf(accountIds: readonly string[]): Promise<Map<string, string>>;
}

export const FEED_REPOSITORY = Symbol("FEED_REPOSITORY");

export const FEED_EVENTS_KEY = "feed:events";
export const weekTopKey = (seasonKey: string, difficulty: Difficulty): string => `feed:week-top:${seasonKey}:${difficulty}`;

/** Ключ событий живёт двое суток: сутки окна и запас на сбой записи. */
const EVENTS_TTL_SEC = 172_800;
/** Лидер недели живёт 15 дней: неделя сезона и запас на запоздавшие забеги. */
const WEEK_TOP_TTL_SEC = 1_296_000;
const REDIS_TIMEOUT_MS = 2_000;
const DB_TIMEOUT_MS = 3_000;

/**
 * «Записать, если больше, и вернуть прежнее» одним атомарным шагом: без него два
 * забега в одну миллисекунду оба сочли бы себя рекордом. Прежнее значение
 * возвращается строкой, чтобы Redis не обрезал его до целого.
 */
const BUMP_SCRIPT = `
local previous = redis.call("GET", KEYS[1])
if not previous then
  redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
  return "-1"
end
if tonumber(ARGV[1]) > tonumber(previous) then
  redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
  return previous
end
return "0"
`;

/** Ответ конвейера Redis: ошибку любой команды поднимаем, а не читаем как успех. */
function replies(result: [Error | null, unknown][] | null): unknown[] {
  if (result === null) throw new Error("Redis не вернул ответ конвейера");
  return result.map(([error, value]) => {
    if (error !== null) throw error;
    return value;
  });
}

@Injectable()
export class LiveFeedRepository implements FeedRepository {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  async add(events: readonly FeedEvent[], nowMs: number): Promise<void> {
    if (events.length === 0) return;
    const pipeline = this.redis.pipeline();
    // Член — стабильная строка события: `NX` не даёт повтору сдвинуть время и задвоить запись.
    for (const event of events) pipeline.zadd(FEED_EVENTS_KEY, "NX", event.atMs, encodeFeedEvent(event));
    // Граница исключена: событие ровно суточной давности ещё видно.
    pipeline.zremrangebyscore(FEED_EVENTS_KEY, "-inf", `(${String(nowMs - FEED_WINDOW_MS)}`);
    pipeline.expire(FEED_EVENTS_KEY, EVENTS_TTL_SEC);
    replies(await withTimeout(pipeline.exec(), REDIS_TIMEOUT_MS, "feed: запись событий"));
  }

  async recent(sinceMs: number, cap: number): Promise<{ events: FeedEvent[]; skipped: number }> {
    const members = await withTimeout(this.redis.zrevrangebyscore(FEED_EVENTS_KEY, "+inf", sinceMs, "LIMIT", 0, cap), REDIS_TIMEOUT_MS, "feed: чтение событий");
    const events: FeedEvent[] = [];
    let skipped = 0;
    for (const member of members) {
      const event = parse(member);
      if (event === null) skipped += 1;
      else events.push(event);
    }
    return { events, skipped };
  }

  async bumpWeekTop(seasonKey: string, difficulty: Difficulty, survivalSec: number): Promise<number> {
    const answer = await withTimeout(
      this.redis.eval(BUMP_SCRIPT, 1, weekTopKey(seasonKey, difficulty), String(survivalSec), String(WEEK_TOP_TTL_SEC)),
      REDIS_TIMEOUT_MS,
      "feed: лидер недели",
    );
    const previous = Number(answer);
    if (!Number.isFinite(previous)) throw new Error("feed: лидер недели вернул не число");
    return previous;
  }

  async namesOf(accountIds: readonly string[]): Promise<Map<string, string>> {
    if (accountIds.length === 0) return new Map();
    const rows = await withTimeout(
      this.prisma.account.findMany({ where: { accountId: { in: [...new Set(accountIds)] }, bannedAt: null }, select: { accountId: true, displayName: true } }),
      DB_TIMEOUT_MS,
      "feed: имена игроков",
    );
    return new Map(rows.map((row) => [row.accountId, row.displayName]));
  }
}

function parse(member: string): FeedEvent | null {
  try {
    const parsed = feedEventSchema.safeParse(JSON.parse(member));
    return parsed.success ? parsed.data : null;
  } catch {
    // Битая строка — пропуск: сервис посчитает такие и скажет в лог раз в минуту.
    return null;
  }
}
