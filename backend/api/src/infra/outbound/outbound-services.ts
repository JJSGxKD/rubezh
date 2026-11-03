/**
 * Сервисы, к которым сервер ходит по сети (docs/35-stage4-plan.md Р91, Р92).
 * Метка идёт в журнал запросов и в выбор прокси, поэтому это список, а не
 * свободная строка: опечатка не заведёт «новый» сервис.
 *
 * - `fx.*` — источники курсов (`modules/fx/fx.refresher.ts`);
 * - `telegram.bot` — Bot API;
 * - `taddy.api`, `taddy.exchange` — реклама и лента заданий Taddy;
 * - `ads.creatives` — креативы сетей;
 * - `ads.postback` — постбэки конверсий в кабинет сети;
 * - `secrets.check` — проверка ключа интеграции из панели;
 * - `proxy.subscription` — загрузка подписки Xray (Р101): адрес секретный, поэтому
 *   только напрямую (`direct_only`) и без пути в журнале.
 */
export const OUTBOUND_SERVICES = [
  "fx.cbr",
  "fx.ecb",
  "fx.erapi",
  "fx.forexrateapi",
  "fx.coingecko",
  "fx.coinmarketcap",
  "fx.tonapi",
  "fx.binance",
  "telegram.bot",
  "taddy.api",
  "taddy.exchange",
  "ads.creatives",
  "ads.postback",
  "secrets.check",
  "proxy.subscription",
] as const;

/** Сервисы, чей адрес целиком секретный: в журнале у них путь всегда `/***`. */
export const SECRET_PATH_SERVICES: readonly OutboundService[] = ["proxy.subscription"];

export type OutboundService = (typeof OUTBOUND_SERVICES)[number];
