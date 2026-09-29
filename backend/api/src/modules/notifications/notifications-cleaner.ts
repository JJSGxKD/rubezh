import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { NOTIFICATION_RETENTION_DAYS } from "./notification-kinds.js";
import { NOTIFICATIONS_REPOSITORY, type NotificationsRepository } from "./notifications.repository.js";

/**
 * Чистка уведомлений старше срока хранения (docs/35-stage4-plan.md §3.17,
 * 90 дней). Проход — под распределённым локом, как возврат бустов
 * (`boosts/boosts-refunder.ts`): при нескольких репликах чистит одна. Пачками
 * и с потолком на проход — чтобы первая чистка после простоя не держала
 * таблицу.
 */

const LOCK_KEY = "notifications:purge:lock";
const TICK_MS = 60 * 60_000;
const LOCK_TTL_MS = 10 * 60_000;
const BATCH = 1_000;
const MAX_BATCHES = 20;
const DAY_MS = 86_400_000;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

@Injectable()
export class NotificationsCleaner implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("notifications");
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(NOTIFICATIONS_REPOSITORY) private readonly repository: NotificationsRepository,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "eval">,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.auth.enabled) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
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
      const claimed = await this.redis.set(LOCK_KEY, token, "PX", LOCK_TTL_MS, "NX");
      if (claimed === null) return null;
      try {
        const before = new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * DAY_MS);
        let purged = 0;
        for (let batch = 0; batch < MAX_BATCHES; batch++) {
          const removed = await this.repository.purge(before, BATCH);
          purged += removed;
          if (removed < BATCH) break;
        }
        if (purged > 0) this.logger.log(JSON.stringify({ module: "notifications", event: "purged", count: purged }));
        return purged;
      } finally {
        await this.redis.eval(RELEASE_SCRIPT, 1, LOCK_KEY, token);
      }
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "notifications", event: "purge_failed", reason: error instanceof Error ? error.message : "unknown" }));
      return null;
    } finally {
      this.running = false;
    }
  }
}
