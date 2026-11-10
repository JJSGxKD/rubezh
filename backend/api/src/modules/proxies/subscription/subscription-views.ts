import type { NodeState, StoredNode, StoredSubscription } from "./subscription.repository.js";

/**
 * Подписки и узлы в ответе панели и в аудите (docs/35-stage4-plan.md Р101, Р192).
 * Адреса подписки здесь нет вовсе — только подсказка «хост …abcd»; секретов
 * узла (UUID, пароль) в таблицах нет, поэтому и в ответе их нет.
 */

export interface SubscriptionView {
  /** ключ подписки: неизменен с рождения, по нему идут все действия */
  key: string;
  name: string;
  urlHint: string;
  enabled: boolean;
  countries: string[];
  lastRefreshAt: string | null;
  lastRefreshOk: boolean | null;
  lastRefreshNote: string | null;
  /** байты числом: до 2^53 — это петабайты */
  trafficUsedBytes: number | null;
  trafficTotalBytes: number | null;
  expiresAt: string | null;
  updatedAt: string;
}

export interface NodeView {
  nodeKey: string;
  name: string;
  protocol: string;
  country: string | null;
  host: string;
  state: NodeState;
  latencyMs: number | null;
}

/** Подписка в обзоре: карточка и её узлы. */
export interface SubscriptionEntry extends SubscriptionView {
  nodes: NodeView[];
}

export interface SubscriptionsOverview {
  /** можно ли сохранять адрес: есть ключ шифрования */
  encryption: boolean;
  /** каталог тома с конфигом есть — контейнер Xray подключён */
  sidecar: { connected: boolean };
  /** сколько подписок можно подключить (`SUBSCRIPTIONS_MAX`) */
  limit: number;
  /** входов Xray всего (`XRAY_SLOT_COUNT`) */
  slotCount: number;
  /** доля входов одной подписки сейчас */
  slotQuota: number;
  /** по времени подключения */
  subscriptions: SubscriptionEntry[];
}

export function subscriptionView(row: StoredSubscription): SubscriptionView {
  return {
    key: row.key,
    name: row.name,
    urlHint: row.urlHint,
    enabled: row.enabled,
    countries: row.countries,
    lastRefreshAt: row.lastRefreshAt?.toISOString() ?? null,
    lastRefreshOk: row.lastRefreshOk,
    lastRefreshNote: row.lastRefreshNote,
    trafficUsedBytes: row.trafficUsedBytes === null ? null : Number(row.trafficUsedBytes),
    trafficTotalBytes: row.trafficTotalBytes === null ? null : Number(row.trafficTotalBytes),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const STATE_RANK: Record<NodeState, number> = { healthy: 0, unknown: 1, down: 2 };

/** Рабочие сверху, быстрые первыми; затем не проверенные, затем не отвечающие. */
export function nodeViews(nodes: readonly StoredNode[]): NodeView[] {
  return [...nodes]
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity) || a.name.localeCompare(b.name))
    .map((node) => ({ nodeKey: node.nodeKey, name: node.name, protocol: node.protocol, country: node.country, host: node.host, state: node.state, latencyMs: node.latencyMs }));
}

/** Подписка в аудите: название и подсказка адреса, без адреса. Ключ подписки — цель записи. */
export function subscriptionAudit(row: StoredSubscription): Record<string, unknown> {
  return { name: row.name, urlHint: row.urlHint, countries: row.countries, enabled: row.enabled };
}
