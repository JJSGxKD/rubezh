import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { PRISMA } from "../../../infra/database.js";
import type { UrlColumns } from "./subscription-url.js";

/**
 * Подписки Xray и их узлы в базе (`proxy_subscription`,
 * `proxy_subscription_node`, docs/35-stage4-plan.md Р101, Р192). Запрос к базе
 * живёт здесь, а не в сервисе (docs/15-engineering-standards.md §2.3). Секретов
 * узла (UUID, пароль) в таблицах нет: они только в конфиге Xray и в файлах-частях
 * его тома.
 */

/**
 * Ключ исходной подписки, появившейся до нескольких (Р101). Ключ неизменен с
 * рождения: от него зависят шифртекст адреса и `x-hwid`. Новые подписки получают
 * ключ из 12 hex (`newSubscriptionKey`); эта константа нужна только комментарию
 * и тесту миграции.
 */
export const LEGACY_SUBSCRIPTION_KEY = "main";

export const NODE_STATES = ["unknown", "healthy", "down"] as const;
export type NodeState = (typeof NODE_STATES)[number];

export interface StoredSubscription extends UrlColumns {
  key: string;
  name: string;
  enabled: boolean;
  /** ISO-коды стран узлов; пусто — любые */
  countries: string[];
  lastRefreshAt: Date | null;
  lastRefreshOk: boolean | null;
  lastRefreshNote: string | null;
  providerIntervalHours: number | null;
  trafficUsedBytes: bigint | null;
  trafficTotalBytes: bigint | null;
  expiresAt: Date | null;
  updatedBy: string;
  updatedAt: Date;
  /** когда подключена: порядок карточек в панели */
  createdAt: Date;
}

export interface StoredNode {
  subscriptionKey: string;
  nodeKey: string;
  slot: number;
  protocol: string;
  name: string;
  country: string | null;
  host: string;
  state: NodeState;
  failures: number;
  latencyMs: number | null;
  lastProbeAt: Date | null;
  nextProbeAt: Date;
}

export interface SubscriptionSnapshot {
  subscription: StoredSubscription;
  nodes: StoredNode[];
}

/** Итог обновления: набор узлов целиком и сведения поставщика — одной транзакцией. */
export interface RefreshWrite {
  at: Date;
  ok: boolean;
  note: string;
  nodes: StoredNode[];
  providerIntervalHours: number | null;
  trafficUsedBytes: bigint | null;
  trafficTotalBytes: bigint | null;
  expiresAt: Date | null;
}

export interface ProbeWrite {
  nodeKey: string;
  state: NodeState;
  failures: number;
  latencyMs: number | null;
  lastProbeAt: Date | null;
  nextProbeAt: Date;
}

export const SUBSCRIPTION_REPOSITORY = Symbol("SUBSCRIPTION_REPOSITORY");

export interface SubscriptionRepository {
  /** все подписки с узлами: по времени подключения, узлы по слоту */
  list(): Promise<SubscriptionSnapshot[]>;
  load(key: string): Promise<SubscriptionSnapshot | null>;
  count(): Promise<number>;
  /** новая подписка; ключ занят — ошибка, а не молчаливая замена */
  create(row: StoredSubscription): Promise<void>;
  /**
   * Правка подписки; `false` — её нет. Без `dropNodes` пишутся только поля формы
   * (название, страны, включена, кто менял): итог обновления, записанный другой
   * репликой между чтением и записью, не затирается. С `dropNodes` адрес заменён —
   * строка пишется целиком, а узлы прежнего адреса удаляются.
   */
  save(row: StoredSubscription, options?: { dropNodes: boolean }): Promise<boolean>;
  applyRefresh(key: string, write: RefreshWrite): Promise<void>;
  /** неудачное обновление: узлы и конфиг не трогаются, меняется только итог */
  recordFailure(key: string, at: Date, note: string): Promise<void>;
  saveProbes(key: string, probes: ProbeWrite[]): Promise<void>;
  /** «Проверить узлы»: все узлы к проверке сейчас */
  scheduleAllProbes(key: string, at: Date): Promise<void>;
  /** снять узлы сверх доли входов: слоты освобождаются для других подписок */
  dropNodes(key: string, nodeKeys: readonly string[]): Promise<void>;
  /** `false` — подписки нет */
  remove(key: string): Promise<boolean>;
}

const isState = (value: string): value is NodeState => (NODE_STATES as readonly string[]).includes(value);

type NodeRow = Omit<StoredNode, "state"> & { state: string };
type SubscriptionRow = Omit<StoredSubscription, "countries"> & { countries: string[] | null; nodes: NodeRow[] };

/** Состояние держит CHECK в базе; незнакомое значение — строка, записанная в обход миграции. */
function nodeOf(row: NodeRow): StoredNode {
  if (!isState(row.state)) throw new Error(`proxy_subscription_node ${row.nodeKey}: состояние «${row.state}» вне перечня`);
  return { ...row, state: row.state };
}

const bytes = (value: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(value);

function snapshotOf(row: SubscriptionRow): SubscriptionSnapshot {
  const { nodes, ...subscription } = row;
  return { subscription: { ...subscription, countries: row.countries ?? [] }, nodes: nodes.map(nodeOf) };
}

/** Адрес и итоги обновления, которые меняются только вместе с адресом: другой адрес — другая подписка. */
function addressColumns(row: StoredSubscription) {
  return {
    urlIv: bytes(row.urlIv),
    urlTag: bytes(row.urlTag),
    urlCt: bytes(row.urlCt),
    urlKeyId: row.urlKeyId,
    urlHint: row.urlHint,
    lastRefreshAt: row.lastRefreshAt,
    lastRefreshOk: row.lastRefreshOk,
    lastRefreshNote: row.lastRefreshNote,
    providerIntervalHours: row.providerIntervalHours,
    trafficUsedBytes: row.trafficUsedBytes,
    trafficTotalBytes: row.trafficTotalBytes,
    expiresAt: row.expiresAt,
  };
}

@Injectable()
export class PrismaSubscriptionRepository implements SubscriptionRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(): Promise<SubscriptionSnapshot[]> {
    const rows = await this.prisma.proxySubscription.findMany({ orderBy: [{ createdAt: "asc" }, { key: "asc" }], include: { nodes: { orderBy: { slot: "asc" } } } });
    return rows.map(snapshotOf);
  }

  async load(key: string): Promise<SubscriptionSnapshot | null> {
    const row = await this.prisma.proxySubscription.findUnique({ where: { key }, include: { nodes: { orderBy: { slot: "asc" } } } });
    return row === null ? null : snapshotOf(row);
  }

  async count(): Promise<number> {
    return await this.prisma.proxySubscription.count();
  }

  async create(row: StoredSubscription): Promise<void> {
    await this.prisma.proxySubscription.create({ data: { ...row, urlIv: bytes(row.urlIv), urlTag: bytes(row.urlTag), urlCt: bytes(row.urlCt) } });
  }

  async save(row: StoredSubscription, options: { dropNodes: boolean } = { dropNodes: false }): Promise<boolean> {
    const form = { name: row.name, enabled: row.enabled, countries: row.countries, updatedBy: row.updatedBy, updatedAt: row.updatedAt };
    const data = options.dropNodes ? { ...form, ...addressColumns(row) } : form;
    return await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.proxySubscription.updateMany({ where: { key: row.key }, data });
      if (count === 0) return false;
      if (options.dropNodes) await tx.proxySubscriptionNode.deleteMany({ where: { subscriptionKey: row.key } });
      return true;
    });
  }

  async applyRefresh(key: string, write: RefreshWrite): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Набор заменяется целиком: слот уникален, и при перестановке слотов между
      // узлами построчная правка упёрлась бы в собственную уникальность.
      await tx.proxySubscriptionNode.deleteMany({ where: { subscriptionKey: key } });
      await tx.proxySubscriptionNode.createMany({ data: write.nodes.map((node) => ({ ...node, subscriptionKey: key })) });
      await tx.proxySubscription.update({
        where: { key },
        data: {
          lastRefreshAt: write.at,
          lastRefreshOk: write.ok,
          lastRefreshNote: write.note,
          providerIntervalHours: write.providerIntervalHours,
          trafficUsedBytes: write.trafficUsedBytes,
          trafficTotalBytes: write.trafficTotalBytes,
          expiresAt: write.expiresAt,
        },
      });
    });
  }

  async recordFailure(key: string, at: Date, note: string): Promise<void> {
    await this.prisma.proxySubscription.updateMany({ where: { key }, data: { lastRefreshAt: at, lastRefreshOk: false, lastRefreshNote: note } });
  }

  async saveProbes(key: string, probes: ProbeWrite[]): Promise<void> {
    if (probes.length === 0) return;
    await this.prisma.$transaction(
      probes.map((probe) =>
        this.prisma.proxySubscriptionNode.updateMany({
          where: { subscriptionKey: key, nodeKey: probe.nodeKey },
          data: { state: probe.state, failures: probe.failures, latencyMs: probe.latencyMs, lastProbeAt: probe.lastProbeAt, nextProbeAt: probe.nextProbeAt },
        }),
      ),
    );
  }

  async scheduleAllProbes(key: string, at: Date): Promise<void> {
    await this.prisma.proxySubscriptionNode.updateMany({ where: { subscriptionKey: key }, data: { nextProbeAt: at } });
  }

  async dropNodes(key: string, nodeKeys: readonly string[]): Promise<void> {
    if (nodeKeys.length === 0) return;
    await this.prisma.proxySubscriptionNode.deleteMany({ where: { subscriptionKey: key, nodeKey: { in: [...nodeKeys] } } });
  }

  async remove(key: string): Promise<boolean> {
    // Узлы уходят каскадом внешнего ключа.
    const { count } = await this.prisma.proxySubscription.deleteMany({ where: { key } });
    return count > 0;
  }
}
