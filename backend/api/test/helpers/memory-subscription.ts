import type { ConfigPart, ConfigWriter } from "../../src/modules/proxies/subscription/xray-config-writer.js";
import { SidecarMissingError } from "../../src/modules/proxies/subscription/xray-config-writer.js";
import type { ProbeWrite, RefreshWrite, StoredNode, StoredSubscription, SubscriptionRepository, SubscriptionSnapshot } from "../../src/modules/proxies/subscription/subscription.repository.js";

/**
 * Подписки Xray в памяти: то, что в базе лежит таблицами `proxy_subscription` и
 * `proxy_subscription_node`. Повторяет каскад, замену набора узлов за одну
 * запись и уникальность слота между подписками, чтобы сервис не отличал её от
 * настоящей.
 */
export class MemorySubscriptionRepository implements SubscriptionRepository {
  rows: StoredSubscription[] = [];
  /** узлы всех подписок; у каждого свой `subscriptionKey` */
  nodes: StoredNode[] = [];
  /** сколько раз набор узлов записывался целиком — проверка «ничего не записано» */
  refreshWrites = 0;

  /** Исходная подписка (ключ `main`): в тестах одной подписки она единственная. */
  get subscription(): StoredSubscription | null {
    return this.rowOf("main");
  }

  rowOf(key: string): StoredSubscription | null {
    return this.rows.find((row) => row.key === key) ?? null;
  }

  nodesOf(key: string): StoredNode[] {
    return this.nodes.filter((node) => node.subscriptionKey === key);
  }

  async list(): Promise<SubscriptionSnapshot[]> {
    return [...this.rows]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.key < b.key ? -1 : 1))
      .map((row) => ({ subscription: { ...row }, nodes: this.nodesOf(row.key).sort((a, b) => a.slot - b.slot).map((node) => ({ ...node })) }));
  }

  async load(key: string): Promise<SubscriptionSnapshot | null> {
    return (await this.list()).find((snapshot) => snapshot.subscription.key === key) ?? null;
  }

  async count(): Promise<number> {
    return this.rows.length;
  }

  async create(row: StoredSubscription): Promise<void> {
    if (this.rowOf(row.key) !== null) throw new Error(`proxy_subscription ${row.key}: ключ уже занят`);
    this.rows.push({ ...row });
  }

  async save(row: StoredSubscription, options: { dropNodes: boolean } = { dropNodes: false }): Promise<boolean> {
    const index = this.rows.findIndex((item) => item.key === row.key);
    if (index < 0) return false;
    if (options.dropNodes) {
      this.rows[index] = { ...row };
      this.nodes = this.nodes.filter((node) => node.subscriptionKey !== row.key);
    } else {
      // Без смены адреса правятся только поля формы: итоги обновления другая запись не затирает.
      this.rows[index] = { ...(this.rows[index] as StoredSubscription), name: row.name, enabled: row.enabled, countries: [...row.countries], updatedBy: row.updatedBy, updatedAt: row.updatedAt };
    }
    return true;
  }

  async applyRefresh(key: string, write: RefreshWrite): Promise<void> {
    const index = this.rows.findIndex((row) => row.key === key);
    if (index < 0) return;
    const taken = new Set(this.nodes.filter((node) => node.subscriptionKey !== key).map((node) => node.slot));
    for (const node of write.nodes) {
      if (taken.has(node.slot)) throw new Error(`proxy_subscription_node_slot_key: слот ${String(node.slot)} занят другой подпиской`);
    }
    this.refreshWrites += 1;
    this.rows[index] = {
      ...(this.rows[index] as StoredSubscription),
      lastRefreshAt: write.at,
      lastRefreshOk: write.ok,
      lastRefreshNote: write.note,
      providerIntervalHours: write.providerIntervalHours,
      trafficUsedBytes: write.trafficUsedBytes,
      trafficTotalBytes: write.trafficTotalBytes,
      expiresAt: write.expiresAt,
      routingSource: write.routing.source,
      routingDirect: write.routing.direct,
      routingBlock: write.routing.block,
      routingHints: [...write.routing.hints],
    };
    this.nodes =[...this.nodes.filter((node) => node.subscriptionKey !== key), ...write.nodes.map((node) => ({ ...node, subscriptionKey: key }))];
  }

  async recordFailure(key: string, at: Date, note: string): Promise<void> {
    this.rows = this.rows.map((row) => (row.key === key ? { ...row, lastRefreshAt: at, lastRefreshOk: false, lastRefreshNote: note } : row));
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

  async dropNodes(key: string, nodeKeys: readonly string[]): Promise<void> {
    const dropped = new Set(nodeKeys);
    this.nodes = this.nodes.filter((node) => node.subscriptionKey !== key || !dropped.has(node.nodeKey));
  }

  async remove(key: string): Promise<boolean> {
    if (this.rowOf(key) === null) return false;
    this.rows = this.rows.filter((row) => row.key !== key);
    this.nodes = this.nodes.filter((node) => node.subscriptionKey !== key);
    return true;
  }
}

/**
 * Том спутника в памяти: `config.json` и файлы-части подписок.
 * `available_ = false` — каталога тома нет; `corrupted` — часть лежит, но не
 * читается (испорченный JSON или не по схеме).
 */
export class MemoryConfigWriter implements ConfigWriter {
  /** все записи `config.json` по порядку */
  readonly written: Record<string, unknown>[] = [];
  readonly parts = new Map<string, ConfigPart>();
  readonly corrupted = new Set<string>();
  available_ = true;
  /** файл конфига лежит в томе; запись его создаёт */
  fileExists = true;
  /** сколько раз писались части — проверка «часть не тронута» */
  partWrites = 0;

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

  async writePart(key: string, part: ConfigPart): Promise<void> {
    if (!this.available_) throw new SidecarMissingError();
    this.partWrites += 1;
    this.corrupted.delete(key);
    this.parts.set(key, structuredClone(part));
  }

  async readPart(key: string): Promise<ConfigPart | null> {
    if (this.corrupted.has(key)) return null;
    const part = this.parts.get(key);
    return part === undefined ? null : structuredClone(part);
  }

  async removePart(key: string): Promise<void> {
    this.parts.delete(key);
    this.corrupted.delete(key);
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
