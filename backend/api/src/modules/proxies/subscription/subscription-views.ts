import { DEVICE_OS } from "@bh/proxy-kit";
import { SUBSCRIPTION_USER_AGENT } from "./subscription-download.js";
import type { NodeState, StoredNode, StoredSubscription } from "./subscription.repository.js";

/**
 * Подписки и узлы в ответе панели и в аудите (docs/35-stage4-plan.md Р101, Р192).
 * Адреса подписки здесь нет вовсе — только подсказка «хост …abcd»; секретов
 * узла (UUID, пароль) в таблицах нет, поэтому и в ответе их нет. Идентификатор
 * устройства (`x-hwid`) целиком тоже не выходит: только первые знаки.
 */

export const ROUTING_SOURCES = ["none", "json", "header", "json+header"] as const;
export type RoutingSource = (typeof ROUTING_SOURCES)[number];

/** Своя маршрутизация подписки — только для сведения: наш перебор её не применяет. */
export interface RoutingView {
  source: RoutingSource;
  /** записей мимо туннеля; `null` — заголовок поставщика есть, состав не разобран */
  direct: number | null;
  block: number | null;
  /** `geosite:`/`geoip:` из записей мимо туннеля, до восьми */
  hints: string[];
}

/** Под каким устройством сервер ходит к поставщику: одно на подписку (Р101, T-0093). */
export interface DeviceView {
  count: 1;
  /** первые знаки `x-hwid`; `null` — на сервере нет ключа шифрования */
  hwidPrefix: string | null;
  os: string;
  userAgent: string;
}

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
  /** `null` — подписка не обновлялась после выкатки T-0385 */
  routing: RoutingView | null;
  device: DeviceView;
}

export interface NodeView {
  nodeKey: string;
  name: string;
  protocol: string;
  country: string | null;
  host: string;
  state: NodeState;
  latencyMs: number | null;
  /** транспорт, безопасность и flow из разбора; `null` — узел до первого обновления после выкатки */
  network: string | null;
  security: string | null;
  flow: string | null;
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

const isRoutingSource = (value: string): value is RoutingSource => (ROUTING_SOURCES as readonly string[]).includes(value);

/** Сведения о маршрутизации; источник вне перечня (`CHECK` его не пускает) — как «ещё не известно». */
function routingView(row: StoredSubscription): RoutingView | null {
  if (row.routingSource === null || !isRoutingSource(row.routingSource)) return null;
  return { source: row.routingSource, direct: row.routingDirect, block: row.routingBlock, hints: row.routingHints };
}

export const deviceView = (hwidPrefix: string | null): DeviceView => ({ count: 1, hwidPrefix, os: DEVICE_OS, userAgent: SUBSCRIPTION_USER_AGENT });

/** `hwidPrefix` — отпечаток устройства подписки (`subscriptionHwidPrefix`) либо `null`, если ключа шифрования нет. */
export function subscriptionView(row: StoredSubscription, hwidPrefix: string | null): SubscriptionView {
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
    routing: routingView(row),
    device: deviceView(hwidPrefix),
  };
}

const STATE_RANK: Record<NodeState, number> = { healthy: 0, unknown: 1, down: 2 };

/** Рабочие сверху, быстрые первыми; затем не проверенные, затем не отвечающие. */
export function nodeViews(nodes: readonly StoredNode[]): NodeView[] {
  return [...nodes]
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity) || a.name.localeCompare(b.name))
    .map((node) => ({
      nodeKey: node.nodeKey,
      name: node.name,
      protocol: node.protocol,
      country: node.country,
      host: node.host,
      state: node.state,
      latencyMs: node.latencyMs,
      network: node.network,
      security: node.security,
      flow: node.flow,
    }));
}

/** Подписка в аудите: название и подсказка адреса, без адреса. Ключ подписки — цель записи. */
export function subscriptionAudit(row: StoredSubscription): Record<string, unknown> {
  return { name: row.name, urlHint: row.urlHint, countries: row.countries, enabled: row.enabled };
}
