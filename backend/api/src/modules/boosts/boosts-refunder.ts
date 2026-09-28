import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { BOOST_REFUND } from "./boosts-limits.js";
import { BOOSTS_REPOSITORY, type BoostsRepository } from "./boosts.repository.js";

/**
 * Возврат бустов забегам, которые так и не начались (Р39): клиент не успел
 * попросить возврат сам — приложение закрыли на экране загрузки, пропала
 * сеть. Проход — под распределённым локом, как опрос курсов
 * (`fx/fx.refresher.ts`): при нескольких репликах возвращает одна, а повтор
 * безопасен и без лока — возврат идёт по ключам журнала.
 */

const LOCK_KEY = "boosts:refund:lock";

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

@Injectable()
export class BoostsRefunder implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("boosts");
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(BOOSTS_REPOSITORY) private readonly repository: BoostsRepository,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "eval">,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.auth.enabled) return;
    this.timer = setInterval(() => void this.tick(), BOOST_REFUND.tickMs);
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
      const claimed = await this.redis.set(LOCK_KEY, token, "PX", BOOST_REFUND.lockTtlMs, "NX");
      if (claimed === null) return null;
      try {
        const abandoned = await this.repository.abandoned(new Date(now.getTime() - BOOST_REFUND.windowMs), BOOST_REFUND.batch);
        let refunded = 0;
        // По одной: каждая — своя короткая транзакция, и сбой одной не держит остальные.
        for (const run of abandoned) {
          if ((await this.repository.refund(run.accountId, run.runId, now)) === "refunded") refunded++;
        }
        if (refunded > 0) this.logger.log(JSON.stringify({ module: "boosts", event: "refunded_abandoned", count: refunded }));
        return refunded;
      } finally {
        await this.redis.eval(RELEASE_SCRIPT, 1, LOCK_KEY, token);
      }
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "boosts", event: "refund_pass_failed", reason: error instanceof Error ? error.message : "unknown" }));
      return null;
    } finally {
      this.running = false;
    }
  }
}
