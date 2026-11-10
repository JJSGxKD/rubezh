import { NodePool, POOL_DEFAULTS, type PoolEntry, type ProbeResult } from "@bh/proxy-kit";
import type { OutboundProxy } from "../../../infra/outbound/outbound-route.js";
import { SETTINGS } from "../../settings/setting-catalog.js";
import type { SettingsReader } from "../../settings/settings.service.js";
import { nodeRef } from "./subscription-rules.js";
import type { ProbeWrite, StoredNode, StoredSubscription, SubscriptionRepository, SubscriptionSnapshot } from "./subscription.repository.js";

/**
 * Узлы подписок как прокси для клиента исходящих (docs/35-stage4-plan.md Р101,
 * Р192, tasks/T-0093, tasks/T-0384). Для клиента узел — обычный прокси
 * `socks5://xray:<порт>` без пароля: SOCKS-вход на узел держит контейнер Xray,
 * порт — база плюс слот.
 *
 * Узлы всех включённых подписок идут в **общий** перебор: пул один, узел в нём —
 * `<ключ подписки>:<ключ узла>`. В перебор попадают не все узлы, а `candidates`
 * лучших здоровых на всю систему (по задержке, с фильтром стран своей
 * подписки): перебирать сто узлов на каждом запросе незачем. Узлы выключенной
 * подписки в пул не входят вовсе — ни в перебор, ни в проверки: их входов в
 * конфиге Xray нет.
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

/** Проверка узла, записанная с ключом его подписки: строки двух подписок в таблице разные. */
export interface KeyedProbeWrite extends ProbeWrite {
  subscriptionKey: string;
}

interface Member {
  node: StoredNode;
  subscription: StoredSubscription;
}

const entryOf = (member: Member): PoolEntry => ({
  key: nodeRef(member.node.subscriptionKey, member.node.nodeKey),
  country: member.node.country,
  state: member.node.state,
  failures: member.node.failures,
  latencyMs: member.node.latencyMs,
  lastProbeAt: member.node.lastProbeAt?.getTime() ?? null,
  nextProbeAt: member.node.nextProbeAt.getTime(),
});

export class SubscriptionRoutes {
  private members = new Map<string, Member>();
  private pool = new NodePool();
  private poolMinutes = 0;
  /** выбранные узлы кэшируются до изменения пула, фильтров или числа кандидатов */
  private picked: { candidates: number; refs: string[] } | null = null;

  constructor(private readonly deps: SubscriptionRoutesDeps) {}

  /** Перечитать таблицы и пересобрать пул; возвращает прочитанное. Ошибка базы пробрасывается: остаётся прежний пул. */
  async reload(): Promise<SubscriptionSnapshot[]> {
    const snapshots = await this.deps.repository.list();
    const members = snapshots.filter(({ subscription }) => subscription.enabled).flatMap(({ subscription, nodes }) => nodes.map((node): Member => ({ node, subscription })));
    this.members = new Map(members.map((member) => [nodeRef(member.node.subscriptionKey, member.node.nodeKey), member]));
    this.poolMinutes = this.probeMinutes();
    this.pool = new NodePool({ probeIntervalMs: this.poolMinutes * 60_000 }, members.map(entryOf));
    this.picked = null;
    return snapshots;
  }

  /** Узлов в пуле: у включённых подписок. */
  nodeCount(): number {
    return this.members.size;
  }

  /**
   * Узлы для перебора. `afterPriority` — наибольший приоритет ручных прокси:
   * узлы идут после них, быстрый первым.
   */
  list(afterPriority: number): OutboundProxy[] {
    return this.pickedRefs().flatMap((ref, index) => {
      const member = this.members.get(ref);
      if (member === undefined) return [];
      const port = this.deps.basePort + member.node.slot;
      // Метка правки — порт: он меняется, только когда узел переехал на другой слот,
      // и диспетчер клиента пересоберётся ровно тогда.
      return [{ id: `${NODE_ID_PREFIX}${ref}`, scheme: "socks5" as const, host: this.deps.host, port, username: null, password: null, priority: afterPriority + 1 + index, updatedAt: port }];
    });
  }

  /** Узлы, которым пора на проверку, ссылками `<ключ подписки>:<ключ узла>`. */
  due(now: Date): string[] {
    return this.currentPool().due(now.getTime());
  }

  /** Узел как прокси для проверки — независимо от того, попадёт ли он в перебор. */
  connectionOf(ref: string): OutboundProxy | null {
    const member = this.members.get(ref);
    if (member === undefined) return null;
    const port = this.deps.basePort + member.node.slot;
    return { id: `${NODE_ID_PREFIX}${ref}`, scheme: "socks5", host: this.deps.host, port, username: null, password: null, priority: 0, updatedAt: port };
  }

  record(ref: string, result: ProbeResult, now: Date): void {
    this.currentPool().record(ref, result, now.getTime());
    this.picked = null;
  }

  /** Состояние проверенных узлов для записи в таблицу: у каждой записи ключ её подписки. */
  probeWrites(refs: readonly string[]): KeyedProbeWrite[] {
    const wanted = new Set(refs);
    return this.currentPool()
      .snapshot()
      .filter((entry) => wanted.has(entry.key))
      .flatMap((entry) => {
        const member = this.members.get(entry.key);
        if (member === undefined) return [];
        return [
          {
            subscriptionKey: member.node.subscriptionKey,
            nodeKey: member.node.nodeKey,
            state: entry.state,
            failures: entry.failures,
            latencyMs: entry.latencyMs === null ? null : Math.round(entry.latencyMs),
            lastProbeAt: entry.lastProbeAt === null ? null : new Date(entry.lastProbeAt),
            nextProbeAt: new Date(entry.nextProbeAt),
          },
        ];
      });
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

  private pickedRefs(): string[] {
    const candidates = this.candidates();
    if (this.picked === null || this.picked.candidates !== candidates) {
      this.picked = { candidates, refs: this.currentPool().pick({ limit: candidates, accept: (entry) => this.accepts(entry) }) };
    }
    return this.picked.refs;
  }

  /**
   * Узел проходит, если его подписка включена и он подходит под фильтр стран
   * своей подписки: пусто — любые, узел без страны при фильтре не идёт.
   */
  private accepts(entry: PoolEntry): boolean {
    const member = this.members.get(entry.key);
    if (member === undefined || !member.subscription.enabled) return false;
    const countries = member.subscription.countries;
    return countries.length === 0 || (entry.country !== null && countries.some((country) => country.toUpperCase() === entry.country?.toUpperCase()));
  }
}
