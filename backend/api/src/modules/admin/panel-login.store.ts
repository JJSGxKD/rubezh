import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { z } from "zod";
import { REDIS } from "../../infra/redis.js";

/**
 * Запросы входа в панель через бота (docs/29-admin-panel.md §8): живут
 * минуты и нужны только до выдачи сессии, поэтому в Redis со сроком, а не в
 * базе. Подтверждение и выдача — атомарные скрипты: запрос подтверждается один
 * раз, и сессию по нему получает ровно один опрос.
 */

export type PanelLoginStatus = "pending" | "confirmed" | "declined";

export interface PanelLoginRequest {
  /** хэш секрета, который знает только открывшая запрос вкладка */
  secretHash: string;
  /** код на экране панели — его же показывает бот, чтобы сверить глазами */
  code: string;
  /** браузер и система, как их назвал заголовок: «Chrome · Windows» */
  device: string;
  /** адрес, урезанный до сети: чтобы узнать «это не мой город», а не человека */
  place: string;
  createdAtMs: number;
  status: PanelLoginStatus;
  accountId: string | null;
  /** почему отказано: `declined` — «это не я», `no_role`, `banned` */
  reason: string | null;
}

export const PANEL_LOGIN_STORE = Symbol("PANEL_LOGIN_STORE");

export interface PanelLoginStore {
  create(requestId: string, request: PanelLoginRequest, ttlSec: number): Promise<void>;
  get(requestId: string): Promise<PanelLoginRequest | null>;
  /** Ждущий запрос — в подтверждённый или отклонённый. `false` — он уже не ждёт или истёк. */
  settle(requestId: string, status: "confirmed" | "declined", accountId: string | null, reason: string | null): Promise<boolean>;
  /** Забрать подтверждённый запрос: аккаунт — и запроса больше нет. `null` — не подтверждён или уже забран. */
  take(requestId: string): Promise<string | null>;
}

const SETTLE_SCRIPT = `
if redis.call('HGET', KEYS[1], 'status') ~= 'pending' then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[1], 'accountId', ARGV[2], 'reason', ARGV[3])
return 1`;

const TAKE_SCRIPT = `
if redis.call('HGET', KEYS[1], 'status') ~= 'confirmed' then return false end
local account = redis.call('HGET', KEYS[1], 'accountId')
redis.call('DEL', KEYS[1])
return account`;

/** Строки из Redis — граница: всё, что не разбирается, считается отсутствующим запросом. */
const storedSchema = z.object({
  secretHash: z.string().regex(/^[0-9a-f]{64}$/),
  code: z.string().regex(/^\d{4}$/),
  device: z.string().max(64),
  place: z.string().max(64),
  createdAtMs: z.coerce.number().int(),
  status: z.enum(["pending", "confirmed", "declined"]),
  accountId: z.string().default(""),
  reason: z.string().default(""),
});

@Injectable()
export class RedisPanelLoginStore implements PanelLoginStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async create(requestId: string, request: PanelLoginRequest, ttlSec: number): Promise<void> {
    const key = keyOf(requestId);
    await this.redis
      .multi()
      .hset(key, {
        secretHash: request.secretHash,
        code: request.code,
        device: request.device,
        place: request.place,
        createdAtMs: String(request.createdAtMs),
        status: request.status,
        accountId: request.accountId ?? "",
        reason: request.reason ?? "",
      })
      .expire(key, ttlSec)
      .exec();
  }

  async get(requestId: string): Promise<PanelLoginRequest | null> {
    const raw = await this.redis.hgetall(keyOf(requestId));
    const parsed = storedSchema.safeParse(raw);
    if (!parsed.success) return null;
    const { accountId, reason, ...rest } = parsed.data;
    return { ...rest, accountId: accountId === "" ? null : accountId, reason: reason === "" ? null : reason };
  }

  async settle(requestId: string, status: "confirmed" | "declined", accountId: string | null, reason: string | null): Promise<boolean> {
    return (await this.redis.eval(SETTLE_SCRIPT, 1, keyOf(requestId), status, accountId ?? "", reason ?? "")) === 1;
  }

  async take(requestId: string): Promise<string | null> {
    const account = await this.redis.eval(TAKE_SCRIPT, 1, keyOf(requestId));
    return typeof account === "string" && account !== "" ? account : null;
  }
}

function keyOf(requestId: string): string {
  return `admin:panel-login:${requestId}`;
}
