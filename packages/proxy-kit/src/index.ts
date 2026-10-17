/**
 * Пакет проксирования через подписку Xray: разбор подписки и ссылок узлов,
 * защита адреса подписки от SSRF, загрузка подписки, конфиг контейнера-спутника
 * и пул узлов с проверкой здоровья. Ничего из монорепо, Nest и Prisma — пакет
 * берут в другие проекты. Сеть, время и DNS приходят аргументами.
 */
export { countryOfName } from "./country.js";
export { fetchSubscription, SubscriptionFetchError, type FetchedSubscription, type FetchErrorCode, type FetchSubscriptionOptions } from "./fetch-subscription.js";
export type { NodeNetwork, NodeProtocol, NodeSecurity, NodeTransport, ProxyNode, ShareLinkResult, SkipReason } from "./node.js";
export { NodePool, POOL_DEFAULTS, type PoolEntry, type PoolOptions, type ProbeResult } from "./pool.js";
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
export { assignSlots, buildXrayConfig, type XrayConfigOptions } from "./xray-config.js";
