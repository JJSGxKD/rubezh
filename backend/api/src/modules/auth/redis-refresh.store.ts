import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import type { RefreshSession, RefreshStore, RefreshTake } from "./refresh.store.js";

/**
 * Токены продления в Redis (docs/34-stage3-plan.md, WP1).
 *
 * Ключи:
 * - `auth:rt:<хэш>` → `<аккаунт>:<когда выпущен>` — сам токен;
 * - `auth:used:<хэш>` → `<аккаунт>` — след погашенного: по нему узнаётся
 *   повторное использование;
 * - `auth:sessions:<аккаунт>` — ZSET устройств, очки — время выпуска.
 *
 * Срок жизни набора сессий продлевается **только вверх** (`EXPIRE … GT`):
 * иначе вход с одного устройства укорачивал бы жизнь сессиям остальных
 * (docs/13-reuse-from-vpnsibcom.md §4).
 */

/**
 * Гашение одним скриптом: прочитать, удалить, оставить след. Порознь между
 * чтением и удалением помещается второй запрос, и одним токеном продлились бы
 * обе сессии — ровно то, что ротация должна исключать.
 */
const TAKE_SCRIPT = `
local value = redis.call("GET", KEYS[1])
if value then
  redis.call("DEL", KEYS[1])
  redis.call("SET", KEYS[2], value, "EX", ARGV[1])
  return { "ok", value }
end
local used = redis.call("GET", KEYS[2])
if used then return { "reused", used } end
return { "unknown", "" }
`;

@Injectable()
export class RedisRefreshStore implements RefreshStore {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async issue(accountId: string, tokenHash: string, issuedAtMs: number): Promise<void> {
    const ttl = this.config.auth.refreshTtlSec;
    const sessions = sessionsKey(accountId);

    await this.redis
      .multi()
      .set(tokenKey(tokenHash), `${accountId}:${issuedAtMs}`, "EX", ttl)
      .zadd(sessions, issuedAtMs, tokenHash)
      .expire(sessions, ttl, "GT")
      .exec();

    await this.trim(accountId);
  }

  async take(tokenHash: string): Promise<RefreshTake> {
    const ttl = this.config.auth.refreshTtlSec;
    const result = (await this.redis.eval(TAKE_SCRIPT, 2, tokenKey(tokenHash), usedKey(tokenHash), String(ttl))) as [
      string,
      string,
    ];
    const [status, value] = result;

    if (status === "reused") return { status: "reused", accountId: accountOf(value) };
    if (status !== "ok") return { status: "unknown" };

    const session = parseSession(value);
    if (session === null) return { status: "unknown" };
    // Чистка набора устройств — не часть корректности: забытый там хэш
    // указывает на уже удалённый ключ и никого не пускает.
    await this.redis.zrem(sessionsKey(session.accountId), tokenHash);
    return { status: "ok", session };
  }

  async restore(session: RefreshSession, tokenHash: string): Promise<void> {
    const remaining = this.remainingTtlSec(session.issuedAtMs);
    if (remaining <= 0) return;

    await this.redis
      .multi()
      .set(tokenKey(tokenHash), `${session.accountId}:${session.issuedAtMs}`, "EX", remaining)
      .del(usedKey(tokenHash))
      .zadd(sessionsKey(session.accountId), session.issuedAtMs, tokenHash)
      .exec();
  }

  async revokeAll(accountId: string): Promise<number> {
    const sessions = sessionsKey(accountId);
    const hashes = await this.redis.zrange(sessions, "0", "-1");
    if (hashes.length > 0) await this.redis.del(...hashes.map(tokenKey));
    await this.redis.del(sessions);
    return hashes.length;
  }

  /** Сверх потолка устройств вытесняются самые старые сессии. */
  private async trim(accountId: string): Promise<void> {
    const sessions = sessionsKey(accountId);
    const extra = (await this.redis.zcard(sessions)) - this.config.auth.maxSessions;
    if (extra <= 0) return;

    const stale = await this.redis.zrange(sessions, "0", String(extra - 1));
    if (stale.length === 0) return;
    await this.redis.del(...stale.map(tokenKey));
    await this.redis.zrem(sessions, ...stale);
  }

  private remainingTtlSec(issuedAtMs: number): number {
    return Math.floor(this.config.auth.refreshTtlSec - (Date.now() - issuedAtMs) / 1000);
  }
}

function tokenKey(hash: string): string {
  return `auth:rt:${hash}`;
}

function usedKey(hash: string): string {
  return `auth:used:${hash}`;
}

function sessionsKey(accountId: string): string {
  return `auth:sessions:${accountId}`;
}

function accountOf(value: string): string {
  return value.slice(0, value.lastIndexOf(":"));
}

/** Значение вида `<аккаунт>:<когда выпущен>`; битое считается отсутствующим. */
export function parseSession(value: string): RefreshSession | null {
  const at = value.lastIndexOf(":");
  if (at <= 0) return null;

  const issuedAtMs = Number(value.slice(at + 1));
  if (!Number.isInteger(issuedAtMs) || issuedAtMs <= 0) return null;
  return { accountId: value.slice(0, at), issuedAtMs };
}
