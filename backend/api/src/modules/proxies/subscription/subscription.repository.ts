import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../../generated/prisma/client.js";
import { PRISMA } from "../../../infra/database.js";
import type { UrlColumns } from "./subscription-url.js";

/**
 * Подписка Xray и её узлы в базе (`proxy_subscription`,
 * `proxy_subscription_node`, docs/35-stage4-plan.md Р101). Запрос к базе живёт
 * здесь, а не в сервисе (docs/15-engineering-standards.md §2.3). Секретов узла
 * (UUID, пароль) в таблицах нет: они только в конфиге Xray.
 */

/** Подписка одна на систему. */
export const SUBSCRIPTION_KEY = "main";

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
  load(): Promise<SubscriptionSnapshot | null>;
  /** создать или заменить строку подписки; `dropNodes` — узлы прежнего адреса больше не нужны */
  save(row: StoredSubscription, options?: { dropNodes: boolean }): Promise<void>;
  applyRefresh(key: string, write: RefreshWrite): Promise<void>;
  /** неудачное обновление: узлы и конфиг не трогаются, меняется только итог */
  recordFailure(key: string, at: Date, note: string): Promise<void>;
  saveProbes(key: string, probes: ProbeWrite[]): Promise<void>;
  /** «Проверить узлы»: все узлы к проверке сейчас */
  scheduleAllProbes(key: string, at: Date): Promise<void>;
  /** `false` — подписки нет */
  remove(key: string): Promise<boolean>;
}

const isState = (value: string): value is NodeState => (NODE_STATES as readonly string[]).includes(value);

/** Состояние держит CHECK в базе; незнакомое значение — строка, записанная в обход миграции. */
function nodeOf(row: Omit<StoredNode, "state"> & { state: string }): StoredNode {
  if (!isState(row.state)) throw new Error(`proxy_subscription_node ${row.nodeKey}: состояние «${row.state}» вне перечня`);
  return { ...row, state: row.state };
}

const bytes = (value: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(value);

@Injectable()
export class PrismaSubscriptionRepository implements SubscriptionRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async load(): Promise<SubscriptionSnapshot | null> {
    const row = await this.prisma.proxySubscription.findUnique({ where: { key: SUBSCRIPTION_KEY }, include: { nodes: { orderBy: { slot: "asc" } } } });
    if (row === null) return null;
    const { nodes, ...subscription } = row;
    return { subscription: { ...subscription, countries: subscription.countries ?? [] }, nodes: nodes.map(nodeOf) };
  }

  async save(row: StoredSubscription, options: { dropNodes: boolean } = { dropNodes: false }): Promise<void> {
    const { key, ...columns } = row;
    const data = { ...columns, urlIv: bytes(row.urlIv), urlTag: bytes(row.urlTag), urlCt: bytes(row.urlCt) };
    await this.prisma.$transaction(async (tx) => {
      if (options.dropNodes) await tx.proxySubscriptionNode.deleteMany({ where: { subscriptionKey: key } });
      await tx.proxySubscription.upsert({ where: { key }, create: { key, ...data }, update: data });
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

  async remove(key: string): Promise<boolean> {
    // Узлы уходят каскадом внешнего ключа.
    const { count } = await this.prisma.proxySubscription.deleteMany({ where: { key } });
    return count > 0;
  }
}
