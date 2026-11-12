import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { z } from "zod";
import { withTimeout } from "../../common/with-timeout.js";
import { REDIS } from "../../infra/redis.js";
import { LINK_PLATFORMS, type LinkTarget } from "./external-identity-rules.js";

/**
 * Одноразовые коды связи аккаунтов (docs/35-stage4-plan.md Р188,
 * tasks/T-0377): код выдаётся игроку в ссылке на бота, бот площадки
 * возвращает его вместе с id игрока. Лежит в Redis, а не в базе: живёт полчаса
 * и забирается атомарно.
 */

export type { LinkTarget } from "./external-identity-rules.js";

export const LINK_CODE_STORE = Symbol("LINK_CODE_STORE");

export interface LinkCodeStore {
  /** Положить код на `ttlSec` секунд; `false` — такой код уже есть, нужен другой. */
  put(code: string, target: LinkTarget, ttlSec: number): Promise<boolean>;
  /** Забрать код: он исчезает при первом же чтении, поэтому применить его дважды нельзя. */
  take(code: string): Promise<LinkTarget | null>;
}

const REDIS_TIMEOUT_MS = 2_000;

const targetSchema = z.object({ accountId: z.string().min(1).max(64), platform: z.enum(LINK_PLATFORMS) });

function keyOf(code: string): string {
  return `ext-link:${code}`;
}

@Injectable()
export class RedisLinkCodes implements LinkCodeStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async put(code: string, target: LinkTarget, ttlSec: number): Promise<boolean> {
    // `NX`: чужой код не затирается; `EX` и значение ставятся одной командой, без окна «код без срока».
    const stored = await withTimeout(this.redis.set(keyOf(code), JSON.stringify(target), "EX", ttlSec, "NX"), REDIS_TIMEOUT_MS, "код связи");
    return stored === "OK";
  }

  async take(code: string): Promise<LinkTarget | null> {
    // `GETDEL`: два бота с одним кодом получат значение ровно один раз.
    const raw = await withTimeout(this.redis.getdel(keyOf(code)), REDIS_TIMEOUT_MS, "код связи");
    return parse(raw);
  }
}

/** Значение из Redis — граница системы: битое читается как «кода нет», а не падением бота. */
function parse(raw: string | null): LinkTarget | null {
  if (raw === null) return null;
  try {
    const parsed = targetSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
