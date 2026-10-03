import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { RestrictionsService } from "./restrictions.service.js";

/**
 * Последствия истёкших ограничений (docs/35-stage4-plan.md WP44): блокировка
 * на сутки снимается сама, без участия команды. Само ограничение истекает по
 * времени без задачи — задача снимает то, что живёт вне таблицы.
 *
 * Раз в минуту, под распределённым локом, как возврат бустов
 * (`boosts/boosts-refunder.ts`): при нескольких репликах проходит одна, а
 * повтор безопасен и без лока — снятое отмечено и второй раз не выбирается.
 */

const LOCK_KEY = "restrictions:settle:lock";
const TICK_MS = 60_000;
const LOCK_TTL_MS = 50_000;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

@Injectable()
export class RestrictionsSettler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("restrictions");
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "eval">,
    private readonly restrictions: RestrictionsService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.databaseUrl === "") return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** Один проход; `null` — не запускался: идёт предыдущий, лок у другой реплики или Redis недоступен. */
  async tick(now = new Date()): Promise<number | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const token = randomUUID();
      if ((await this.redis.set(LOCK_KEY, token, "PX", LOCK_TTL_MS, "NX")) === null) return null;
      try {
        const settled = await this.restrictions.settleDue(now);
        if (settled > 0) this.logger.log(JSON.stringify({ module: "restrictions", event: "restrictions_settled", count: settled }));
        return settled;
      } finally {
        await this.redis.eval(RELEASE_SCRIPT, 1, LOCK_KEY, token);
      }
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "restrictions", event: "settle_pass_failed", reason: error instanceof Error ? error.message : "unknown" }));
      return null;
    } finally {
      this.running = false;
    }
  }
}
