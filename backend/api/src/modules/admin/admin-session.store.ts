import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { z } from "zod";
import { REDIS } from "../../infra/redis.js";
import { PLATFORM_IDS, type PlatformId } from "../../platforms/ports/platform.js";

/**
 * Сессии панели в Redis (docs/29-admin-panel.md §8). Своя стратегия, а не
 * токен игрока: у панели cookie и короткий срок, у игры — Bearer и токен
 * продления; общего у них только аккаунт.
 *
 * Ключи:
 * - `admin:session:<хэш>` → JSON сессии, TTL — до её конца;
 * - `admin:sessions:<аккаунт>` — набор хэшей аккаунта: снятие роли или
 *   блокировка отзывают все его сессии сразу, а не по истечении срока.
 *
 * Интерфейс отдельно от Redis: сервис и гвард проверяются в памяти,
 * реализация — на живом Redis в интеграционном тесте.
 */
export interface AdminSession {
  accountId: string;
  platform: PlatformId;
  platformUserId: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

export const ADMIN_SESSION_STORE = Symbol("ADMIN_SESSION_STORE");

export interface AdminSessionStore {
  put(tokenHash: string, session: AdminSession): Promise<void>;
  get(tokenHash: string): Promise<AdminSession | null>;
  delete(tokenHash: string): Promise<void>;
  /** Отозвать все сессии аккаунта; возвращает, сколько их было. */
  revokeAll(accountId: string): Promise<number>;
}

const sessionSchema = z.object({
  accountId: z.string().uuid(),
  platform: z.enum(PLATFORM_IDS),
  platformUserId: z.string().min(1).max(32),
  issuedAtMs: z.number().int().positive(),
  expiresAtMs: z.number().int().positive(),
});

/** В хранилище — только хэш: токен из cookie не восстановить из слепка Redis. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

@Injectable()
export class RedisAdminSessionStore implements AdminSessionStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async put(tokenHash: string, session: AdminSession): Promise<void> {
    const ttlSec = Math.max(1, Math.ceil((session.expiresAtMs - Date.now()) / 1000));
    const sessions = sessionsKey(session.accountId);
    await this.redis
      .multi()
      .set(sessionKey(tokenHash), JSON.stringify(session), "EX", ttlSec)
      .sadd(sessions, tokenHash)
      // Набор живёт не короче самой длинной сессии: вход со второго устройства
      // не должен укорачивать жизнь набору первого. Одного GT мало: ключ без
      // срока Redis считает бесконечным и GT его не трогает, а SADD как раз
      // создаёт набор без срока — NX ставит первый срок, GT продлевает.
      .expire(sessions, ttlSec, "NX")
      .expire(sessions, ttlSec, "GT")
      .exec();
  }

  async get(tokenHash: string): Promise<AdminSession | null> {
    const value = await this.redis.get(sessionKey(tokenHash));
    if (value === null) return null;
    // JSON из Redis — данные с границы: разбираются схемой, битое — нет сессии.
    const parsed = sessionSchema.safeParse(safeJson(value));
    return parsed.success ? parsed.data : null;
  }

  async delete(tokenHash: string): Promise<void> {
    const session = await this.get(tokenHash);
    await this.redis.del(sessionKey(tokenHash));
    if (session !== null) await this.redis.srem(sessionsKey(session.accountId), tokenHash);
  }

  async revokeAll(accountId: string): Promise<number> {
    const sessions = sessionsKey(accountId);
    const hashes = await this.redis.smembers(sessions);
    if (hashes.length > 0) await this.redis.del(...hashes.map(sessionKey));
    await this.redis.del(sessions);
    return hashes.length;
  }
}

function sessionKey(hash: string): string {
  return `admin:session:${hash}`;
}

function sessionsKey(accountId: string): string {
  return `admin:sessions:${accountId}`;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
