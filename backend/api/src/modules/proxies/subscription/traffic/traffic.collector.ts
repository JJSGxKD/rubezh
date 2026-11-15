import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { trafficOfStats, type NodeTraffic } from "@bh/proxy-kit";
import type { SubscriptionRepository } from "../subscription.repository.js";
import type { TrafficRepository, TrafficRow } from "./traffic.repository.js";
import { CLEANUP_MS, COLLECT_MS, DAY_MS, hourOf, LOG_THROTTLE_MS, PENDING_MAX, TRAFFIC_RETENTION_DAYS } from "./traffic-rules.js";
import type { StatsSource } from "./xray-stats.client.js";

/**
 * Сборщик трафика узлов Xray (docs/35-stage4-plan.md Р192, tasks/T-0386): раз в
 * минуту читает счётчики ядра со сбросом и прибавляет их к корзине текущего часа.
 *
 * - **Без замка.** Чтение со сбросом атомарно в самом Xray: две реплики получают
 *   непересекающиеся прибавки, а запись в базу — прибавлением. Внутри процесса
 *   циклы идут по очереди: параллельные `collect` и `flush` иначе записали бы одни
 *   и те же отложенные строки дважды.
 * - **Прочитанное не теряется.** Сброс уже произошёл, поэтому строки, которые не
 *   записались, ждут в памяти (до `PENDING_MAX`) и прибавляются на следующем цикле.
 *   Список подписок с названиями узлов читается *до* Xray: упади он после сброса,
 *   прочитанное пришлось бы выбросить.
 * - **Перезапуск Xray** обнуляет счётчики сам: при чтении со сбросом это не даёт ни
 *   отрицательных, ни задвоенных чисел, теряется только трафик между чтением и
 *   перезапуском. Поэтому перед записью нового конфига API зовёт `flush`.
 * - **Сбой ничего не роняет.** Xray нет (dev, контейнер перезапускается) или база
 *   недоступна — предупреждение в лог не чаще раза в 10 минут, без адреса и текста
 *   ошибки, и таймер живёт дальше.
 *
 * Раз в час удаляет корзины старше срока хранения.
 */

export interface CollectorDeps {
  source: StatsSource;
  repository: TrafficRepository;
  subscriptions: Pick<SubscriptionRepository, "list">;
  /** запускать таймер при старте приложения; без базы — нет */
  autostart?: boolean;
}

const NAME_MAX = 80;

const keyOf = (row: Pick<TrafficRow, "hour" | "subscriptionKey" | "nodeKey">): string => `${row.hour.getTime()}|${row.subscriptionKey}|${row.nodeKey}`;

export class TrafficCollector implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("proxy-traffic");
  private timer: NodeJS.Timeout | null = null;
  /** прочитано из Xray, но ещё не записано в базу; порядок вставки — от старых к новым */
  private readonly pending = new Map<string, TrafficRow>();
  private lastRead: Date | null = null;
  private lastCleanupMs = Number.NEGATIVE_INFINITY;
  private readonly lastLoggedMs = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: CollectorDeps) {}

  /** Когда эта реплика в последний раз получила счётчики от Xray; `null` — ещё ни разу. */
  get lastCollectedAt(): Date | null {
    return this.lastRead;
  }

  onApplicationBootstrap(): void {
    if (this.deps.autostart === false) return;
    this.timer = setInterval(() => void this.collect(), COLLECT_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  /** Один цикл: прочитать счётчики, записать накопленное, раз в час — удалить старое. Ошибок не бросает. */
  collect(now: Date = new Date()): Promise<void> {
    const run = this.queue.then(() => this.cycle(now));
    this.queue = run;
    return run;
  }

  /** Снять счётчики сейчас — перед записью нового конфига, после которого Xray перезапустится. */
  flush(): Promise<void> {
    return this.collect();
  }

  private async cycle(now: Date): Promise<void> {
    try {
      await this.read(now);
      await this.write(now);
      await this.cleanup(now);
    } catch (error: unknown) {
      // Этапы ловят свои сбои сами; сюда доходит только ошибка в самом сборщике — цепочка циклов от неё не рвётся.
      this.warn("cycle_failed", now, error);
    }
  }

  private async read(now: Date): Promise<void> {
    let names: Map<string, string>;
    try {
      names = await this.names();
    } catch (error: unknown) {
      this.warn("subscriptions_failed", now, error);
      return;
    }

    let traffic: NodeTraffic[];
    try {
      traffic = trafficOfStats(await this.deps.source.query(true));
    } catch (error: unknown) {
      this.warn("stats_unavailable", now, error);
      return;
    }
    this.lastRead = now;

    const hour = hourOf(now);
    for (const item of traffic) {
      if (item.bytes === 0n) continue;
      const base = { hour, subscriptionKey: item.group, nodeKey: item.nodeKey };
      const key = keyOf(base);
      const row = this.pending.get(key) ?? { ...base, nodeName: "", upBytes: 0n, downBytes: 0n };
      // Название — последнее известное: узел мог переименоваться, пока строка ждала записи.
      row.nodeName = (names.get(`${item.group}|${item.nodeKey}`) ?? item.nodeKey).slice(0, NAME_MAX);
      if (item.direction === "up") row.upBytes += item.bytes;
      else row.downBytes += item.bytes;
      this.pending.set(key, row);
    }
  }

  private async write(now: Date): Promise<void> {
    if (this.pending.size === 0) return;
    try {
      await this.deps.repository.add([...this.pending.values()]);
      this.pending.clear();
    } catch (error: unknown) {
      this.warn("write_failed", now, error);
      this.trimPending();
    }
  }

  /** Сверх предела отбрасываются самые старые строки: потеря минут учёта, а не деньги и не память процесса. */
  private trimPending(): void {
    const excess = this.pending.size - PENDING_MAX;
    if (excess <= 0) return;
    let dropped = 0;
    for (const key of this.pending.keys()) {
      if (dropped >= excess) break;
      this.pending.delete(key);
      dropped += 1;
    }
    this.logger.warn(JSON.stringify({ module: "proxy-traffic", event: "pending_dropped", dropped }));
  }

  private async cleanup(now: Date): Promise<void> {
    if (now.getTime() - this.lastCleanupMs < CLEANUP_MS) return;
    try {
      // По границе часа: корзина уходит, когда целиком старше срока.
      await this.deps.repository.deleteBefore(hourOf(new Date(now.getTime() - TRAFFIC_RETENTION_DAYS * DAY_MS)));
      this.lastCleanupMs = now.getTime();
    } catch (error: unknown) {
      this.warn("cleanup_failed", now, error);
    }
  }

  /** Названия узлов по `подписка|узел`. */
  private async names(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const { subscription, nodes } of await this.deps.subscriptions.list()) {
      for (const node of nodes) names.set(`${subscription.key}|${node.nodeKey}`, node.name);
    }
    return names;
  }

  /** Предупреждение одного вида — не чаще раза в `LOG_THROTTLE_MS`; причина — имя ошибки, без текста: в нём бывают адреса. */
  private warn(event: string, now: Date, error: unknown): void {
    const last = this.lastLoggedMs.get(event);
    if (last !== undefined && now.getTime() - last < LOG_THROTTLE_MS) return;
    this.lastLoggedMs.set(event, now.getTime());
    this.logger.warn(JSON.stringify({ module: "proxy-traffic", event, reason: error instanceof Error ? error.name : "unknown" }));
  }
}
