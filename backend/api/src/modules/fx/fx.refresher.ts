import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import {
  createBinanceSource,
  createCbrSource,
  createCoinGeckoSource,
  createEcbSource,
  createErApiSource,
  createTonApiSource,
  monthOf,
  refreshRates,
  type RateAlerts,
  type RateSource,
  type RateStore,
  type RefreshReport,
} from "@bh/fx";
import type { Redis } from "ioredis";
import { SECRETS } from "../secrets/secret-catalog.js";
import { SECRETS_READER, type SecretsReader } from "../secrets/secrets.service.js";
import { FeatureSwitches } from "../settings/feature-switches.js";
import { Outbound } from "../../infra/outbound/outbound.js";
import type { OutboundService } from "../../infra/outbound/outbound-services.js";
import { REDIS } from "../../infra/redis.js";
import { FxHooks } from "./fx-hooks.js";
import { applyLimits, crossedThresholds } from "./fx-limits.js";
import { FX_STORE, type LimitStore } from "./fx.store.js";

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
 *
 * **Лимиты из панели** (Р89, T-0062). Перед проходом читаются лимиты, и у
 * источников подменяется тариф: ядро считает расписание по лимиту панели, а не
 * только по тарифу из кода. После прохода сравнивается счётчик «до» и «после»:
 * порог 80% или 100%, перейдённый впервые за месяц, — событие для чата команды.
 * «Впервые» держит Redis (`SET NX`) на 35 суток: повтор прохода и вторая реплика
 * второго сообщения не дадут.
 */

const TICK_MS = 60_000;
const LOCK_KEY = "fx:refresh:lock";
const LOCK_TTL_MS = 90_000;
const BUDGET_KEY_TTL_SEC = 35 * 24 * 60 * 60;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

/**
 * Источники одного прохода. Ключ CoinGecko читается здесь, на каждом
 * проходе: заменённый в панели работает со следующей минуты без
 * перезапуска (docs/35-stage4-plan.md Р84). Платный важнее демо.
 */
export function fxSources(secrets: SecretsReader, fetchFor: (service: OutboundService) => typeof fetch = () => fetch): RateSource[] {
  const pro = secrets.get(SECRETS.coingeckoPro);
  const demo = secrets.get(SECRETS.coingeckoDemo);
  const key = pro !== null ? { plan: "pro" as const, value: pro } : demo !== null ? { plan: "demo" as const, value: demo } : null;
  return [
    createCbrSource({ fetch: fetchFor("fx.cbr") }),
    createEcbSource({ fetch: fetchFor("fx.ecb") }),
    createErApiSource({ fetch: fetchFor("fx.erapi") }),
    createCoinGeckoSource({ fetch: fetchFor("fx.coingecko"), ...(key === null ? {} : { key }) }),
    createTonApiSource({ fetch: fetchFor("fx.tonapi") }),
    createBinanceSource({ fetch: fetchFor("fx.binance") }),
  ];
}

@Injectable()
export class FxRefresher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("fx");
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(SECRETS_READER) private readonly secrets: SecretsReader,
    // Без лимитов (хранилище ядра в тестах) источники идут по тарифу из кода.
    @Inject(FX_STORE) private readonly store: RateStore & Partial<LimitStore>,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "eval">,
    private readonly hooks: FxHooks,
    private readonly switches: FeatureSwitches,
    // Без модуля клиента (тесты) источники берут глобальный fetch.
    @Optional() private readonly outbound?: Outbound,
  ) {}

  /** Клиент источника с меткой сервиса; без клиента — глобальный fetch. */
  private fetchFor(): (service: OutboundService) => typeof fetch {
    const outbound = this.outbound;
    return outbound === undefined ? () => fetch : (service) => outbound.forService(service);
  }

  /**
   * Таймер идёт всегда, а опрос включают и выключают на ходу из панели:
   * выключенный проход заканчивается, не тронув ни лок, ни источники.
   */
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** Один проход; `null` — не запускался: идёт предыдущий, лок у другой реплики или Redis недоступен. */
  async tick(sources: readonly RateSource[] = fxSources(this.secrets, this.fetchFor()), now = new Date()): Promise<RefreshReport | null> {
    if (this.running || !this.switches.fxPolling()) return null;
    this.running = true;
    try {
      const token = randomUUID();
      const claimed = await this.redis.set(LOCK_KEY, token, "PX", LOCK_TTL_MS, "NX");
      if (claimed === null) return null;
      try {
        const limited = applyLimits(sources, (await this.store.limits?.()) ?? new Map());
        const before = await this.usedThisMonth(limited, now);
        const report = await refreshRates({ sources: limited, store: this.store, alerts: this.alerts(), now });
        await this.announceBudget(limited, before, now);
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

  /** Сколько запросов источники с месячным лимитом сделали в месяце `now`; счётчик прошлого месяца — ноль. */
  private async usedThisMonth(sources: readonly RateSource[], now: Date): Promise<Map<string, number>> {
    const month = monthOf(now);
    const used = new Map<string, number>();
    for (const source of sources) {
      if (source.tariff.perMonth === null) continue;
      const state = await this.store.sourceState(source.id);
      used.set(source.id, state?.usage.month === month ? state.usage.used : 0);
    }
    return used;
  }

  /**
   * События о порогах расхода. Сбой Redis или хуков проход не роняет: курсы
   * уже приняты и сохранены, а сообщение о лимите — не причина терять отчёт.
   */
  private async announceBudget(sources: readonly RateSource[], before: ReadonlyMap<string, number>, now: Date): Promise<void> {
    try {
      const month = monthOf(now);
      const after = await this.usedThisMonth(sources, now);
      for (const source of sources) {
        const perMonth = source.tariff.perMonth;
        const used = after.get(source.id);
        if (perMonth === null || used === undefined) continue;
        for (const threshold of crossedThresholds(before.get(source.id) ?? 0, used, perMonth)) {
          const first = await this.redis.set(`fx:budget:${source.id}:${month}:${String(threshold)}`, "1", "EX", BUDGET_KEY_TTL_SEC, "NX");
          if (first !== null) this.hooks.emit({ kind: "source_budget", source: source.id, month, used, perMonth, threshold });
        }
      }
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "fx", event: "budget_alert_failed", reason: error instanceof Error ? error.message : "unknown" }));
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
