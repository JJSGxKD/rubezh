import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import {
  createBinanceSource,
  createCbrSource,
  createCoinGeckoSource,
  createEcbSource,
  createErApiSource,
  createTonApiSource,
  refreshRates,
  type RateAlerts,
  type RateSource,
  type RateStore,
  type RefreshReport,
} from "@bh/fx";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { FxHooks } from "./fx-hooks.js";
import { FX_STORE } from "./fx.store.js";

/**
 * Обновление курсов по расписанию (docs/35-stage4-plan.md, §3.12). Раз в
 * минуту — проход ядра `refreshRates`: источникам, которым пора, он задаёт
 * вопрос, остальных пропускает. Сама частота опроса — у тарифа источника.
 *
 * Проход — под распределённым локом Redis: при нескольких репликах API
 * источники спрашивает одна, и бюджет запросов не делится на число реплик.
 * Срок лока — худший проход: шесть источников по десять секунд и база.
 * Снимается лок только своим токеном — проход, переживший свой лок, не снимет
 * чужой.
 */

const TICK_MS = 60_000;
const LOCK_KEY = "fx:refresh:lock";
const LOCK_TTL_MS = 90_000;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export function fxSources(config: AppConfig, fetchImpl: typeof fetch = fetch): RateSource[] {
  const key = config.fx.coingeckoKey;
  return [
    createCbrSource({ fetch: fetchImpl }),
    createEcbSource({ fetch: fetchImpl }),
    createErApiSource({ fetch: fetchImpl }),
    createCoinGeckoSource({ fetch: fetchImpl, ...(key === null ? {} : { key }) }),
    createTonApiSource({ fetch: fetchImpl }),
    createBinanceSource({ fetch: fetchImpl }),
  ];
}

@Injectable()
export class FxRefresher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("fx");
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FX_STORE) private readonly store: RateStore,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "eval">,
    private readonly hooks: FxHooks,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.fx.enabled) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** Один проход; `null` — не запускался: идёт предыдущий, лок у другой реплики или Redis недоступен. */
  async tick(sources: readonly RateSource[] = fxSources(this.config), now = new Date()): Promise<RefreshReport | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const token = randomUUID();
      const claimed = await this.redis.set(LOCK_KEY, token, "PX", LOCK_TTL_MS, "NX");
      if (claimed === null) return null;
      try {
        const report = await refreshRates({ sources, store: this.store, alerts: this.alerts(), now });
        // В лог — только проход, в котором что-то случилось: иначе он растёт
        // на строку в минуту без пользы.
        if (report.accepted.length + report.rejected.length + report.failed.length > 0) {
          this.logger.log(JSON.stringify({ module: "fx", event: "refreshed", ...report }));
        }
        return report;
      } finally {
        await this.redis.eval(RELEASE_SCRIPT, 1, LOCK_KEY, token);
      }
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "fx", event: "refresh_failed", reason: error instanceof Error ? error.message : "unknown" }));
      return null;
    } finally {
      this.running = false;
    }
  }

  private alerts(): RateAlerts {
    return {
      rejected: (currency, decision) =>
        this.hooks.emit({ kind: "rate_rejected", currency, reason: decision.reason, candidate: decision.candidate.toFixed(), previous: decision.previous?.toFixed() ?? null }),
      stale: (currency, state, purpose) => this.hooks.emit({ kind: "rate_stale", currency, state, purpose: purpose ?? null }),
      sourceFailed: (source, reason) => this.hooks.emit({ kind: "source_failed", source, reason }),
    };
  }
}
