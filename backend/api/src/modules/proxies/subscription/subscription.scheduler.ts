import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { ProxyFetch } from "../../../infra/outbound/outbound-route.js";
import { SETTINGS } from "../../settings/setting-catalog.js";
import type { SettingsReader } from "../../settings/settings.service.js";
import { probeNode } from "./proxy-probe.js";
import { REFRESH_LOCK_KEY, REFRESH_LOCK_TTL_MS, withLock, type LockRedis } from "./subscription-lock.js";
import type { ProbeWrite, StoredSubscription, SubscriptionRepository } from "./subscription.repository.js";
import type { KeyedProbeWrite, SubscriptionRoutes } from "./subscription-routes.js";
import type { SubscriptionSync } from "./subscription.sync.js";
import type { ConfigWriter } from "./xray-config-writer.js";

/**
 * Расписание подписок Xray (docs/35-stage4-plan.md Р101, Р192, tasks/T-0093,
 * tasks/T-0384), по образцу обновления курсов (`modules/fx/fx.refresher.ts`):
 * тик раз в 30 секунд, на каждом — обновление подписок, которым пора, и проверки
 * узлов, которым пора.
 *
 * - **Период обновления** подписки — `max(настройка, интервал поставщика)`, не
 *   больше 168 часов. После неудачи повтор через 15 минут, а не через период:
 *   сбой поставщика обычно короткий.
 * - **Не больше трёх подписок за тик**, по одной, начиная с той, что дольше всех
 *   ждёт: загрузка подписки идёт до 15 секунд, три укладываются в срок замка.
 *   Остальные подхватят следующие тики. Выключенные подписки — никогда.
 * - **Части нет** (том Xray пересоздан, после выкатки этой версии, часть не
 *   читается), а подписка включена и последнее обновление не провалилось —
 *   обновление немедленно, не через период: иначе её узлов нет в конфиге, а
 *   перебор отдаёт на их входы запросы. После сбоя действует повтор через
 *   15 минут, поставщика не долбим каждый тик.
 * - **Файла `config.json` нет**, а каталог тома есть: конфиг пересобирается из
 *   частей без загрузки подписок — Xray иначе стоит без входов.
 * - **Проверки** — не раньше 20 секунд после записи конфига (Xray перезапускается
 *   и не принимает подключения), по пять параллельно и не больше 25 за тик,
 *   чтобы проход укладывался в срок замка. Остальные подхватит следующий тик.
 * - Замок Redis общий с обновлением и правками конфига: узлы проверяет одна реплика.
 */

const TICK_MS = 30_000;
const RETRY_AFTER_FAILURE_MS = 15 * 60_000;
const MAX_PERIOD_HOURS = 168;
/** Три загрузки по 15 секунд укладываются в замок на 120 секунд вместе с записью конфига. */
const REFRESHES_PER_TICK = 3;
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
  /** когда эта реплика сама пересобрала конфиг: Xray после этого перезапускается */
  private rebuiltAt = 0;

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
      const snapshots = await this.deps.routes.reload();
      const enabled = snapshots.map((snapshot) => snapshot.subscription).filter((subscription) => subscription.enabled);
      if (enabled.length === 0) return;

      const available = await this.deps.writer.available();
      await this.refreshDue(enabled, available, now);
      if (available && !(await this.deps.writer.exists())) await this.rebuild(now);

      const fresh = (await this.deps.routes.reload()).map((snapshot) => snapshot.subscription).filter((subscription) => subscription.enabled);
      const writtenAt = Math.max(this.rebuiltAt, ...fresh.map((subscription) => subscription.lastRefreshAt?.getTime() ?? 0));
      if (now.getTime() - writtenAt < PROBE_DELAY_AFTER_WRITE_MS) return;
      await this.probeDue(now);
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "proxy-subscription", event: "tick_failed", reason: error instanceof Error ? error.name : "unknown" }));
    } finally {
      this.running = false;
    }
  }

  /** Обновить подписки, которым пора, — не больше трёх, дольше всех ждущая первой. */
  private async refreshDue(enabled: readonly StoredSubscription[], available: boolean, now: Date): Promise<void> {
    const lost = available ? new Set(await this.deps.sync.missingParts()) : new Set<string>();
    const due = enabled
      .filter((subscription) => this.refreshIsDue(subscription, now) || (lost.has(subscription.key) && subscription.lastRefreshOk !== false))
      .sort((a, b) => (a.lastRefreshAt?.getTime() ?? -Infinity) - (b.lastRefreshAt?.getTime() ?? -Infinity) || a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, REFRESHES_PER_TICK);
    for (const subscription of due) {
      const result = await this.deps.sync.refresh(subscription.key, now);
      // Замок у другой реплики: остальные подписки обновит она или следующий тик.
      if (result.status === "busy") return;
    }
  }

  private async rebuild(now: Date): Promise<void> {
    const result = await this.deps.sync.rebuild();
    if (result.status === "ok") this.rebuiltAt = now.getTime();
  }

  private refreshIsDue(subscription: StoredSubscription, now: Date): boolean {
    if (subscription.lastRefreshAt === null) return true;
    const passed = now.getTime() - subscription.lastRefreshAt.getTime();
    if (subscription.lastRefreshOk === false) return passed >= RETRY_AFTER_FAILURE_MS;
    const hours = Math.min(MAX_PERIOD_HOURS, Math.max(this.deps.settings.get(SETTINGS.proxySubscriptionRefreshHours), subscription.providerIntervalHours ?? 0));
    return passed >= hours * 3_600_000;
  }

  private async probeDue(now: Date): Promise<void> {
    const refs = this.deps.routes.due(now).slice(0, PROBES_PER_TICK);
    if (refs.length === 0) return;
    const locked = await withLock(this.deps.redis, REFRESH_LOCK_KEY, REFRESH_LOCK_TTL_MS, async () => {
      for (let start = 0; start < refs.length; start += PROBE_PARALLEL) {
        const batch = refs.slice(start, start + PROBE_PARALLEL);
        await Promise.all(batch.map((ref) => this.probe(ref, now)));
        await this.saveProbes(this.deps.routes.probeWrites(batch));
      }
      return true;
    });
    if (locked.ran) await this.deps.changed();
  }

  /** Записи проверок по подпискам: у узлов разных подписок свои строки. */
  private async saveProbes(writes: readonly KeyedProbeWrite[]): Promise<void> {
    const grouped = new Map<string, ProbeWrite[]>();
    for (const { subscriptionKey, ...probe } of writes) grouped.set(subscriptionKey, [...(grouped.get(subscriptionKey) ?? []), probe]);
    for (const [key, probes] of grouped) await this.deps.repository.saveProbes(key, probes);
  }

  private async probe(ref: string, now: Date): Promise<void> {
    const node = this.deps.routes.connectionOf(ref);
    if (node === null) return;
    this.deps.routes.record(ref, await probeNode(this.deps.proxyFetch, node), now);
  }
}
