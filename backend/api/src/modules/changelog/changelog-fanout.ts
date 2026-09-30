import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { FANOUT_ACTIVE_DAYS, FANOUT_BATCH, FANOUT_MAX_BATCHES, releaseDedupeKey } from "./changelog-rules.js";
import { CHANGELOG_REPOSITORY, type ChangelogReleaseRecord, type ChangelogRepository } from "./changelog.repository.js";

/**
 * Раздача уведомления о выходе версии (docs/35-stage4-plan.md WP31): каждому
 * игроку площадок версии — строка `app_update` в ленту, а дальше дубль в бота
 * по его выбору (`notifications-bot`, ключ `bot.updates`).
 *
 * - пачками по `FANOUT_BATCH` аккаунтов, курсор — последний id в таблице
 *   раздачи: перезапуск посреди раздачи продолжает с места, а не с начала;
 * - одна версия — одно уведомление аккаунту: ключ события в ленте, поэтому
 *   повтор пачки и раздача заново после новой публикации дублей не дают;
 * - курсор сдвигается только своего поколения: публикация посреди прохода
 *   начинает раздачу заново, и старый проход её курсор не перепишет;
 * - проход — под распределённым локом, как чистка ленты: при нескольких
 *   репликах раздаёт одна; потолок пачек за проход — чтобы лок не держался
 *   долго, остальное — следующим проходом.
 */

const LOCK_KEY = "changelog:fanout:lock";
const TICK_MS = 60_000;
const LOCK_TTL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

@Injectable()
export class ChangelogFanout implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("changelog");
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CHANGELOG_REPOSITORY) private readonly repository: ChangelogRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: Pick<AccountRepository, "recipientsPage">,
    @Inject(NotificationsService) private readonly notifications: Pick<NotificationsService, "deliverMany">,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "eval">,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.auth.enabled) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** Начать проход сейчас, не дожидаясь таймера: публикация не ждёт минуту. Ответ панели проход не держит. */
  kick(): void {
    if (this.timer === null) return;
    void this.tick();
  }

  /** Один проход; сколько уведомлений записано, `null` — не запускался: идёт предыдущий, лок у другой реплики или сбой. */
  async tick(now = new Date()): Promise<number | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const token = randomUUID();
      const claimed = await this.redis.set(LOCK_KEY, token, "PX", LOCK_TTL_MS, "NX");
      if (claimed === null) return null;
      try {
        let written = 0;
        let budget = FANOUT_MAX_BATCHES;
        for (const release of await this.repository.pendingReleases()) {
          const pass = await this.run(release, budget, now);
          written += pass.written;
          budget -= pass.batches;
          if (budget <= 0) break;
        }
        return written;
      } finally {
        await this.redis.eval(RELEASE_SCRIPT, 1, LOCK_KEY, token);
      }
    } catch (error: unknown) {
      this.log("warn", "fanout_failed", { reason: error instanceof Error ? error.message : "unknown" });
      return null;
    } finally {
      this.running = false;
    }
  }

  private async run(release: ChangelogReleaseRecord, budget: number, now: Date): Promise<{ written: number; batches: number }> {
    const seenSince = new Date(now.getTime() - FANOUT_ACTIVE_DAYS * DAY_MS);
    let cursor = release.cursor;
    let written = 0;
    for (let batch = 0; batch < budget; batch++) {
      const accountIds = await this.accounts.recipientsPage({ platforms: release.platforms, seenSince, after: cursor, limit: FANOUT_BATCH });
      written += await this.notifications.deliverMany({ accountIds, kind: "app_update", payload: { version: release.version }, dedupeKey: releaseDedupeKey(release.version), at: release.publishedAt });
      const done = accountIds.length < FANOUT_BATCH;
      cursor = accountIds[accountIds.length - 1] ?? cursor;
      if (!(await this.repository.advanceRelease(release.version, release.publishedAt, cursor, done ? now : null))) {
        this.log("log", "fanout_restarted", { version: release.version });
        return { written, batches: batch + 1 };
      }
      if (done) {
        this.log("log", "fanout_done", { version: release.version, written });
        return { written, batches: batch + 1 };
      }
    }
    return { written, batches: budget };
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "changelog", event, ...fields }));
  }
}
