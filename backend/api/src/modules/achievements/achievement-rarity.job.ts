import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { RARITY_LOCK_KEY, RARITY_LOCK_TTL_MS, RARITY_QUERY_TIMEOUT_MS, RARITY_TICK_MS, rarityDue } from "./achievement-rules.js";
import { ACHIEVEMENTS_REPOSITORY, type AchievementsRepository, type RarityReport } from "./achievements.repository.js";

/**
 * Пересчёт редкости «есть у N%» по расписанию (docs/39-retention-mechanics.md К1,
 * tasks/T-0106). Раз в десять минут задача смотрит, не пора ли: таблица пуста или
 * последний пересчёт старше периода из настройки панели (`achievements.rarity-refresh-min`).
 * Сам пересчёт — один запрос по игрокам с забегом, замена таблицы одной транзакцией.
 *
 * Пересчитывает одна реплика за раз: лок Redis с токеном берётся `SET … NX PX` и
 * снимается скриптом только своим токеном — проход, переживший свой лок, чужой не
 * снимет. Срок лока дольше потолка запроса, поэтому лок не истекает посреди
 * пересчёта. Сбой — в лог (`rarity_failed`), старые числа остаются.
 */

const REDIS_TIMEOUT_MS = 2_000;
const DB_TIMEOUT_MS = 3_000;
/** Пересчёт дольше потолка запроса и короче срока лока: ждём его целиком, но не бесконечно. */
const RECOMPUTE_TIMEOUT_MS = RARITY_QUERY_TIMEOUT_MS + 30_000;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

@Injectable()
export class AchievementRarityJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("achievements");
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ACHIEVEMENTS_REPOSITORY) private readonly repository: AchievementsRepository,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "eval">,
  ) {}

  /** Без базы (процесс без `DATABASE_URL`) считать нечего. */
  onApplicationBootstrap(): void {
    if (this.config.databaseUrl === "") return;
    this.timer = setInterval(() => void this.tick(), RARITY_TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /**
   * Один проход. `null` — пересчёта не было: ещё не пора, идёт предыдущий, лок у другой
   * реплики, Redis недоступен или пересчёт упал.
   */
  async tick(now = new Date()): Promise<RarityReport | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const refreshMin = this.settings.get(SETTINGS.achievementsRarityRefreshMin);
      if (!rarityDue(await this.db(this.repository.rarityComputedAt()), now, refreshMin)) return null;
      const token = randomUUID();
      const claimed = await withTimeout(this.redis.set(RARITY_LOCK_KEY, token, "PX", RARITY_LOCK_TTL_MS, "NX"), REDIS_TIMEOUT_MS, "лок редкости");
      if (claimed === null) return null;
      try {
        // Пока этот проход ждал лок, другая реплика могла уже пересчитать: смотрим ещё раз.
        if (!rarityDue(await this.db(this.repository.rarityComputedAt()), now, refreshMin)) return null;
        const report = await withTimeout(this.repository.recomputeRarity(now), RECOMPUTE_TIMEOUT_MS, "пересчёт редкости");
        this.logger.log(JSON.stringify({ module: "achievements", event: "rarity_computed", rows: report.rows, population: report.population }));
        return report;
      } finally {
        await withTimeout(this.redis.eval(RELEASE_SCRIPT, 1, RARITY_LOCK_KEY, token), REDIS_TIMEOUT_MS, "снятие лока редкости").catch((error: unknown) => {
          this.logger.warn(JSON.stringify({ module: "achievements", event: "rarity_unlock_failed", reason: error instanceof Error ? error.message : "unknown" }));
        });
      }
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "achievements", event: "rarity_failed", reason: error instanceof Error ? error.message : "unknown" }));
      return null;
    } finally {
      this.running = false;
    }
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "достижения");
  }
}
