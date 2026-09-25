import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../../infra/redis.js";

/**
 * Не больше одной карточки разбора на аккаунт за окно. Читер, у которого
 * каждый забег помечается, иначе засыпал бы чат администраторов: лимит
 * приёма пускает сотню итогов в час с аккаунта. Остальные его забеги видны в
 * `GET /runs/review` — карточка лишь зовёт посмотреть.
 *
 * Атомарно, одним `SET NX EX`: две карточки о двух забегах одного аккаунта,
 * пришедших одновременно, не проскочат обе.
 */
export interface ReviewThrottle {
  /** `true` — за окно карточек об этом аккаунте ещё не было, и эта закреплена */
  claim(accountId: string, windowSec: number): Promise<boolean>;
}

export const REVIEW_THROTTLE = Symbol("REVIEW_THROTTLE");

@Injectable()
export class RedisReviewThrottle implements ReviewThrottle {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async claim(accountId: string, windowSec: number): Promise<boolean> {
    return (await this.redis.set(`notify:review:${accountId}`, "1", "EX", windowSec, "NX")) !== null;
  }
}
