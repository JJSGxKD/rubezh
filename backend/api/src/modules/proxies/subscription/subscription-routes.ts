import { NodePool, POOL_DEFAULTS, type PoolEntry, type ProbeResult } from "@bh/proxy-kit";
import type { OutboundProxy } from "../../../infra/outbound/outbound-route.js";
import { SETTINGS } from "../../settings/setting-catalog.js";
import type { SettingsReader } from "../../settings/settings.service.js";
import type { ProbeWrite, StoredNode, SubscriptionRepository, SubscriptionSnapshot } from "./subscription.repository.js";

/**
 * Узлы подписки как прокси для клиента исходящих (docs/35-stage4-plan.md Р101,
 * tasks/T-0093). Для клиента узел — обычный прокси `socks5://xray:<порт>` без
 * пароля: SOCKS-вход на узел держит контейнер Xray, порт — база плюс слот.
 *
 * В переборе не все узлы, а `candidates` лучших здоровых (по задержке, с
 * фильтром стран подписки): перебирать сто узлов на каждом запросе незачем.
 *
 * Состояние пула лежит в таблице узлов: каждая реплика собирает пул из неё
 * (`reload`, раз в 30 секунд и по сообщению об изменении), а проверки пишет та,
 * что держит замок. Чтение — из памяти, без базы: клиент спрашивает маршрут на
 * каждом исходящем запросе.
 */

export interface SubscriptionRoutesDeps {
  repository: SubscriptionRepository;
  settings: SettingsReader;
  /** имя контейнера Xray в сети tunnel */
  host: string;
  /** первый порт SOCKS-входов */
  basePort: number;
}

export const NODE_ID_PREFIX = "node:";

const entryOf = (node: StoredNode): PoolEntry => ({
  key: node.nodeKey,
  country: node.country,
  state: node.state,
  failures: node.failures,
  latencyMs: node.latencyMs,
  lastProbeAt: node.lastProbeAt?.getTime() ?? null,
  nextProbeAt: node.nextProbeAt.getTime(),
});

export class SubscriptionRoutes {
  private snapshot: SubscriptionSnapshot | null = null;
  private nodes = new Map<string, StoredNode>();
  private pool = new NodePool();
  private poolMinutes = 0;
  /** выбранные узлы кэшируются до изменения пула, фильтра или числа кандидатов */
  private picked: { candidates: number; keys: string[] } | null = null;

  constructor(private readonly deps: SubscriptionRoutesDeps) {}

  /** Перечитать таблицы и пересобрать пул; возвращает прочитанное. Ошибка базы пробрасывается: остаётся прежний пул. */
  async reload(): Promise<SubscriptionSnapshot | null> {
    const snapshot = await this.deps.repository.load();
    this.snapshot = snapshot;
    this.nodes = new Map((snapshot?.nodes ?? []).map((node) => [node.nodeKey, node]));
    this.poolMinutes = this.probeMinutes();
    this.pool = new NodePool({ probeIntervalMs: this.poolMinutes * 60_000 }, (snapshot?.nodes ?? []).map(entryOf));
    this.picked = null;
    return snapshot;
  }

  nodeCount(): number {
    return this.nodes.size;
  }

  /** Подписка и фильтр стран из последнего чтения; `null` — подписки нет. */
  current(): { enabled: boolean; countries: readonly string[] } | null {
    return this.snapshot === null ? null : { enabled: this.snapshot.subscription.enabled, countries: this.snapshot.subscription.countries };
  }

  /**
   * Узлы для перебора. `afterPriority` — наибольший приоритет ручных прокси:
   * узлы идут после них, быстрый первым.
   */
  list(afterPriority: number): OutboundProxy[] {
    const snapshot = this.snapshot;
    if (snapshot === null || !snapshot.subscription.enabled) return [];
    return this.pickedKeys(snapshot).flatMap((key, index) => {
      const node = this.nodes.get(key);
      if (node === undefined) return [];
      const port = this.deps.basePort + node.slot;
      // Метка правки — порт: он меняется, только когда узел переехал на другой слот,
      // и диспетчер клиента пересоберётся ровно тогда.
      return [{ id: `${NODE_ID_PREFIX}${key}`, scheme: "socks5" as const, host: this.deps.host, port, username: null, password: null, priority: afterPriority + 1 + index, updatedAt: port }];
    });
  }

  /** Узлы, которым пора на проверку. */
  due(now: Date): string[] {
    return this.currentPool().due(now.getTime());
  }

  /** Узел как прокси для проверки — независимо от того, попадёт ли он в перебор. */
  connectionOf(key: string): OutboundProxy | null {
    const node = this.nodes.get(key);
    if (node === undefined) return null;
    const port = this.deps.basePort + node.slot;
    return { id: `${NODE_ID_PREFIX}${key}`, scheme: "socks5", host: this.deps.host, port, username: null, password: null, priority: 0, updatedAt: port };
  }

  record(key: string, result: ProbeResult, now: Date): void {
    this.currentPool().record(key, result, now.getTime());
    this.picked = null;
  }

  /** Состояние проверенных узлов для записи в таблицу. */
  probeWrites(keys: readonly string[]): ProbeWrite[] {
    const wanted = new Set(keys);
    return this.currentPool()
      .snapshot()
      .filter((entry) => wanted.has(entry.key))
      .map((entry) => ({
        nodeKey: entry.key,
        state: entry.state,
        failures: entry.failures,
        latencyMs: entry.latencyMs === null ? null : Math.round(entry.latencyMs),
        lastProbeAt: entry.lastProbeAt === null ? null : new Date(entry.lastProbeAt),
        nextProbeAt: new Date(entry.nextProbeAt),
      }));
  }

  private candidates(): number {
    return this.deps.settings.get(SETTINGS.proxySubscriptionCandidates);
  }

  private probeMinutes(): number {
    return this.deps.settings.get(SETTINGS.proxySubscriptionProbeMinutes);
  }

  /** Пауза между проверками взята из панели: сменили — пул пересоздаётся с тем же состоянием. */
  private currentPool(): NodePool {
    const minutes = this.probeMinutes();
    if (minutes !== this.poolMinutes) {
      this.pool = new NodePool({ ...POOL_DEFAULTS, probeIntervalMs: minutes * 60_000 }, this.pool.snapshot());
      this.poolMinutes = minutes;
    }
    return this.pool;
  }

  private pickedKeys(snapshot: SubscriptionSnapshot): string[] {
    const candidates = this.candidates();
    if (this.picked === null || this.picked.candidates !== candidates) {
      const countries = snapshot.subscription.countries;
      this.picked = { candidates, keys: this.currentPool().pick({ ...(countries.length > 0 ? { countries } : {}), limit: candidates }) };
    }
    return this.picked.keys;
  }
}
