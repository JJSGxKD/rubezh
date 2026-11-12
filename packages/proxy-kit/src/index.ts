/**
 * Пакет проксирования через подписку Xray: разбор подписки и ссылок узлов,
 * защита адреса подписки от SSRF, загрузка подписки, конфиг контейнера-спутника,
 * пул узлов с проверкой здоровья и сводка своей маршрутизации подписки. Ничего
 * из монорепо, Nest и Prisma — пакет берут в другие проекты. Сеть, время и DNS
 * приходят аргументами.
 */
export { countryOfName } from "./country.js";
export { DEVICE_OS, fetchSubscription, SubscriptionFetchError, type FetchedSubscription, type FetchErrorCode, type FetchSubscriptionOptions } from "./fetch-subscription.js";
export type { NodeNetwork, NodeProtocol, NodeSecurity, NodeTransport, ProxyNode, ShareLinkResult, SkipReason } from "./node.js";
export { proxyNodeSchema } from "./node-schema.js";
export { NodePool, POOL_DEFAULTS, type PoolEntry, type PoolOptions, type ProbeResult } from "./pool.js";
export { hasOwnRouting, mergeRouting, parseRoutingHeader, routingOfConfigs, type RoutingSummary } from "./routing.js";
export { parseShareLink } from "./share-link.js";
export {
  parseSubscription,
  parseUpdateIntervalHours,
  parseUserInfo,
  SubscriptionFormatError,
  type SkippedLink,
  type SubscriptionParse,
  type UserInfo,
} from "./subscription.js";
export { checkSubscriptionUrl, isPublicAddress, type UrlCheck } from "./url-guard.js";
export { assignSlots, buildXrayConfig, GROUP_FORMAT, outboundTag, type PlacedNode, type SlotOptions, type XrayConfigOptions } from "./xray-config.js";
