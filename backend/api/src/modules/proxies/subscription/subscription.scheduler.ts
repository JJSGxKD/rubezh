import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { ProxyFetch } from "../../../infra/outbound/outbound-route.js";
import { SETTINGS } from "../../settings/setting-catalog.js";
import type { SettingsReader } from "../../settings/settings.service.js";
import { probeNode } from "./proxy-probe.js";
import { REFRESH_LOCK_KEY, REFRESH_LOCK_TTL_MS, withLock, type LockRedis } from "./subscription-lock.js";
import { SUBSCRIPTION_KEY, type StoredSubscription, type SubscriptionRepository } from "./subscription.repository.js";
import type { SubscriptionRoutes } from "./subscription-routes.js";
import type { SubscriptionSync } from "./subscription.sync.js";
import type { ConfigWriter } from "./xray-config-writer.js";

/**
 * Расписание подписки Xray (docs/35-stage4-plan.md Р101, tasks/T-0093), по
 * образцу обновления курсов (`modules/fx/fx.refresher.ts`): тик раз в 30 секунд,
 * на каждом — обновление подписки, если пора, и проверки узлов, которым пора.
 *
 * - **Период обновления** — `max(настройка, интервал поставщика)`, не больше 168
 *   часов. После неудачи повтор через 15 минут, а не через период: сбой
 *   поставщика обычно короткий.
 * - **Файла конфига нет** (том Xray пересоздан, сервер переехал), а подписка
 *   считается свежей: обновление немедленно, не через период — иначе Xray стоит
 *   без входов, а перебор отдаёт на них запросы. Только когда каталог тома есть
 *   и прошлое обновление не провалилось: после сбоя действует повтор через
 *   15 минут, поставщика не долбим каждый тик.
 * - **Проверки** — не раньше 20 секунд после записи конфига (Xray перезапускается
 *   и не принимает подключения), по пять параллельно и не больше 25 за тик,
 *   чтобы проход укладывался в срок замка. Остальные подхватит следующий тик.
 * - Замок Redis общий с обновлением: узлы проверяет одна реплика.
 */

const TICK_MS = 30_000;
const RETRY_AFTER_FAILURE_MS = 15 * 60_000;
const MAX_PERIOD_HOURS = 168;
/** Xray перезапускается по хешу конфига раз в 5 секунд и сам поднимается не мгновенно. */
const PROBE_DELAY_AFTER_WRITE_MS = 20_000;
const PROBE_PARALLEL = 5;
const PROBES_PER_TICK = 25;

export interface SchedulerDeps {
  repository: SubscriptionRepository;
  routes: SubscriptionRoutes;
  sync: SubscriptionSync;
  writer: ConfigWriter;
  proxyFetch: ProxyFetch;
  redis: LockRedis;
  settings: SettingsReader;
  /** сообщить остальным репликам, что таблицы изменились */
  changed: () => Promise<void>;
  /** запускать таймер при старте приложения; без базы — нет */
  autostart?: boolean;
}

export class SubscriptionScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("proxy-subscription");
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: SchedulerDeps) {}

  onApplicationBootstrap(): void {
    if (this.deps.autostart === false) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** Один проход; ошибка не роняет таймер, а попадает в лог без адреса. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const snapshot = await this.deps.routes.reload();
      if (snapshot === null || !snapshot.subscription.enabled) return;
      if (this.refreshDue(snapshot.subscription, now) || (await this.configMissing(snapshot.subscription))) await this.deps.sync.refresh(now);

      const fresh = await this.deps.routes.reload();
      if (fresh === null || !fresh.subscription.enabled) return;
      const writtenAt = fresh.subscription.lastRefreshAt?.getTime() ?? 0;
      if (now.getTime() - writtenAt < PROBE_DELAY_AFTER_WRITE_MS) return;
      await this.probeDue(now);
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "proxy-subscription", event: "tick_failed", reason: error instanceof Error ? error.name : "unknown" }));
    } finally {
      this.running = false;
    }
  }

  private refreshDue(subscription: StoredSubscription, now: Date): boolean {
    if (subscription.lastRefreshAt === null) return true;
    const passed = now.getTime() - subscription.lastRefreshAt.getTime();
    if (subscription.lastRefreshOk === false) return passed >= RETRY_AFTER_FAILURE_MS;
    const hours = Math.min(MAX_PERIOD_HOURS, Math.max(this.deps.settings.get(SETTINGS.proxySubscriptionRefreshHours), subscription.providerIntervalHours ?? 0));
    return passed >= hours * 3_600_000;
  }

  private async configMissing(subscription: StoredSubscription): Promise<boolean> {
    if (subscription.lastRefreshOk === false) return false;
    if (!(await this.deps.writer.available())) return false;
    return !(await this.deps.writer.exists());
  }

  private async probeDue(now: Date): Promise<void> {
    const keys = this.deps.routes.due(now).slice(0, PROBES_PER_TICK);
    if (keys.length === 0) return;
    const locked = await withLock(this.deps.redis, REFRESH_LOCK_KEY, REFRESH_LOCK_TTL_MS, async () => {
      for (let start = 0; start < keys.length; start += PROBE_PARALLEL) {
        const batch = keys.slice(start, start + PROBE_PARALLEL);
        await Promise.all(batch.map((key) => this.probe(key, now)));
        await this.deps.repository.saveProbes(SUBSCRIPTION_KEY, this.deps.routes.probeWrites(batch));
      }
      return true;
    });
    if (locked.ran) await this.deps.changed();
  }

  private async probe(key: string, now: Date): Promise<void> {
    const node = this.deps.routes.connectionOf(key);
    if (node === null) return;
    this.deps.routes.record(key, await probeNode(this.deps.proxyFetch, node), now);
  }
}
