import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { REDIS } from "../../infra/redis.js";

/**
 * Замок публикации контента (docs/19-content-admin.md §8, tasks/T-0306): одна
 * публикация или откат на весь кластер. Целостность версий держит база
 * (хэш уникален, указатель — одна строка на аудиторию), а замок нужен, чтобы
 * два человека не двигали указатели вперемешку и чтобы по журналу было видно
 * порядок событий.
 *
 * Токен — у держателя: замок со сроком, и публикация, пережившая его, чужой
 * замок не снимет. Срок есть для умершей реплики: без него публикация стояла
 * бы, пока кто-то не зайдёт в Redis руками.
 */

export const CONTENT_PUBLISH_LOCK = Symbol("CONTENT_PUBLISH_LOCK");

export interface ContentPublishLock {
  /** `true` — замок взят; `false` — его держит другой */
  acquire(token: string, ttlMs: number): Promise<boolean>;
  /** снимает замок, только если в нём ещё токен вызывающего */
  release(token: string): Promise<void>;
}

const LOCK_KEY = "content:publish:lock";
const REDIS_TIMEOUT_MS = 2_000;

/** Снимает замок, только если в нём ещё наш токен. */
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

@Injectable()
export class RedisContentPublishLock implements ContentPublishLock {
  constructor(@Inject(REDIS) private readonly redis: Pick<Redis, "set" | "eval">) {}

  async acquire(token: string, ttlMs: number): Promise<boolean> {
    return (await withTimeout(this.redis.set(LOCK_KEY, token, "PX", ttlMs, "NX"), REDIS_TIMEOUT_MS, "замок публикации контента")) === "OK";
  }

  async release(token: string): Promise<void> {
    await withTimeout(this.redis.eval(RELEASE_SCRIPT, 1, LOCK_KEY, token) as Promise<unknown>, REDIS_TIMEOUT_MS, "снятие замка публикации контента");
  }
}
