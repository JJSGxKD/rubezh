import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";

/**
 * Замок прохода закрытия месяца пасса (tasks/T-0312) — один на все реплики. Токен
 * в значении: чужой замок не продлевается и не снимается. Закрытие длится дольше
 * любого разумного срока, поэтому замок продлевается по ходу прохода, а потерянный
 * (ключ истёк или перехвачен) останавливает проход: выданное остаётся, остальное
 * довыдаст следующий проход — выдача идемпотентна и без замка.
 */

export const PASS_CLOSE_LOCK_KEY = "battle-pass:close:lock";

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;
const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;
const REDIS_TIMEOUT_MS = 2_000;

/** Замок потерян: токен в Redis уже чужой или ключа нет. */
export class PassCloseLockLost extends Error {}

export interface HeldLock {
  token: string;
  renewedAt: number;
}

export class PassCloseLock {
  private readonly logger = new Logger("battle-pass");

  constructor(
    private readonly redis: Pick<Redis, "set" | "eval">,
    private readonly ttlMs: number,
    private readonly renewEveryMs: number,
  ) {}

  /** `null` — замок у другой реплики. */
  async acquire(): Promise<HeldLock | null> {
    const token = randomUUID();
    const taken = await withTimeout(this.redis.set(PASS_CLOSE_LOCK_KEY, token, "PX", this.ttlMs, "NX"), REDIS_TIMEOUT_MS, "батл-пасс: замок закрытия");
    return taken === null ? null : { token, renewedAt: Date.now() };
  }

  /**
   * Продлить замок, если пора. Redis недоступен — идём дальше: двойной проход безопасен, а
   * остановка стоила бы месяца. Замок потерян — `PassCloseLockLost`.
   */
  async keep(lock: HeldLock): Promise<void> {
    if (Date.now() - lock.renewedAt < this.renewEveryMs) return;
    let kept: unknown;
    try {
      kept = await withTimeout(this.redis.eval(RENEW_SCRIPT, 1, PASS_CLOSE_LOCK_KEY, lock.token, String(this.ttlMs)) as Promise<unknown>, REDIS_TIMEOUT_MS, "батл-пасс: продление замка");
    } catch (error: unknown) {
      this.warn("pass_close_lock_renew_failed", error);
      return;
    }
    if (Number(kept) !== 1) throw new PassCloseLockLost();
    lock.renewedAt = Date.now();
  }

  async release(lock: HeldLock): Promise<void> {
    try {
      await withTimeout(this.redis.eval(RELEASE_SCRIPT, 1, PASS_CLOSE_LOCK_KEY, lock.token) as Promise<unknown>, REDIS_TIMEOUT_MS, "батл-пасс: снятие замка");
    } catch (error: unknown) {
      // Замок живёт не дольше TTL: следующий проход увидит его свободным.
      this.warn("pass_close_lock_not_released", error);
    }
  }

  private warn(event: string, error: unknown): void {
    this.logger.warn(JSON.stringify({ module: "battle-pass", event, reason: error instanceof Error ? error.message : "unknown" }));
  }
}
