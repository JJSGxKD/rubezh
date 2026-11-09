import type { NodeState, StoredNode, StoredSubscription } from "./subscription.repository.js";

/**
 * Подписка и узлы в ответе панели и в аудите (docs/35-stage4-plan.md Р101).
 * Адреса подписки здесь нет вовсе — только подсказка «хост …abcd»; секретов
 * узла (UUID, пароль) в таблицах нет, поэтому и в ответе их нет.
 */

export interface SubscriptionView {
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

export interface SubscriptionOverview {
  /** можно ли сохранять адрес: есть ключ шифрования */
  encryption: boolean;
  /** каталог тома с конфигом есть — контейнер Xray подключён */
  sidecar: { connected: boolean };
  subscription: SubscriptionView | null;
  nodes: NodeView[];
}

export function subscriptionView(row: StoredSubscription): SubscriptionView {
  return {
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

/** Подписка в аудите: название и подсказка адреса, без адреса. */
export function subscriptionAudit(row: StoredSubscription): Record<string, unknown> {
  return { name: row.name, urlHint: row.urlHint, countries: row.countries, enabled: row.enabled };
}
