import type { ConfigWriter } from "../../src/modules/proxies/subscription/xray-config-writer.js";
import { SidecarMissingError } from "../../src/modules/proxies/subscription/xray-config-writer.js";
import type { ProbeWrite, RefreshWrite, StoredNode, StoredSubscription, SubscriptionRepository, SubscriptionSnapshot } from "../../src/modules/proxies/subscription/subscription.repository.js";

/**
 * Подписка Xray в памяти: то, что в базе лежит таблицами `proxy_subscription` и
 * `proxy_subscription_node`. Повторяет и каскад, и замену набора узлов за одну
 * запись, чтобы сервис не отличал её от настоящей.
 */
export class MemorySubscriptionRepository implements SubscriptionRepository {
  subscription: StoredSubscription | null = null;
  nodes: StoredNode[] = [];
  /** сколько раз набор узлов записывался целиком — проверка «ничего не записано» */
  refreshWrites = 0;

  async load(): Promise<SubscriptionSnapshot | null> {
    return this.subscription === null ? null : { subscription: { ...this.subscription }, nodes: this.nodes.map((node) => ({ ...node })) };
  }

  async save(row: StoredSubscription, options: { dropNodes: boolean } = { dropNodes: false }): Promise<void> {
    this.subscription = { ...row };
    if (options.dropNodes) this.nodes = [];
  }

  async applyRefresh(key: string, write: RefreshWrite): Promise<void> {
    if (this.subscription === null || this.subscription.key !== key) return;
    this.refreshWrites += 1;
    this.subscription = {
      ...this.subscription,
      lastRefreshAt: write.at,
      lastRefreshOk: write.ok,
      lastRefreshNote: write.note,
      providerIntervalHours: write.providerIntervalHours,
      trafficUsedBytes: write.trafficUsedBytes,
      trafficTotalBytes: write.trafficTotalBytes,
      expiresAt: write.expiresAt,
    };
    this.nodes = write.nodes.map((node) => ({ ...node }));
  }

  async recordFailure(key: string, at: Date, note: string): Promise<void> {
    if (this.subscription === null || this.subscription.key !== key) return;
    this.subscription = { ...this.subscription, lastRefreshAt: at, lastRefreshOk: false, lastRefreshNote: note };
  }

  async saveProbes(key: string, probes: ProbeWrite[]): Promise<void> {
    const byKey = new Map(probes.map((probe) => [probe.nodeKey, probe]));
    this.nodes = this.nodes.map((node) => {
      const probe = byKey.get(node.nodeKey);
      return node.subscriptionKey === key && probe !== undefined ? { ...node, state: probe.state, failures: probe.failures, latencyMs: probe.latencyMs, lastProbeAt: probe.lastProbeAt, nextProbeAt: probe.nextProbeAt } : node;
    });
  }

  async scheduleAllProbes(key: string, at: Date): Promise<void> {
    this.nodes = this.nodes.map((node) => (node.subscriptionKey === key ? { ...node, nextProbeAt: at } : node));
  }

  async remove(key: string): Promise<boolean> {
    if (this.subscription === null || this.subscription.key !== key) return false;
    this.subscription = null;
    this.nodes = [];
    return true;
  }
}

/** Файл конфига Xray в памяти: `available = false` — каталога тома нет. */
export class MemoryConfigWriter implements ConfigWriter {
  readonly written: Record<string, unknown>[] = [];
  available_ = true;
  /** файл конфига лежит в томе; запись его создаёт */
  fileExists = true;

  async available(): Promise<boolean> {
    return this.available_;
  }

  async exists(): Promise<boolean> {
    return this.fileExists;
  }

  async write(config: Record<string, unknown>): Promise<void> {
    if (!this.available_) throw new SidecarMissingError();
    this.fileExists = true;
    this.written.push(config);
  }

  get last(): Record<string, unknown> | undefined {
    return this.written.at(-1);
  }
}

/** Redis для замков и меток «не чаще раза в минуту»: `SET NX PX` и снятие своим токеном. */
export class MemoryLockRedis {
  readonly values = new Map<string, string>();

  async set(key: string, value: string, ...args: (string | number)[]): Promise<"OK" | null> {
    if (args.includes("NX") && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async eval(_script: string, _count: number, key: string, token: string): Promise<number> {
    if (this.values.get(key) !== token) return 0;
    this.values.delete(key);
    return 1;
  }

  /** Заранее занять замок — как если бы его держала другая реплика. */
  hold(key: string): void {
    this.values.set(key, "другая-реплика");
  }
}
