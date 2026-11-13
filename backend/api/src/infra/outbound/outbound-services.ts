/**
 * Сервисы, к которым сервер ходит по сети (docs/35-stage4-plan.md Р91, Р92).
 * Метка идёт в журнал запросов и в выбор прокси, поэтому это список, а не
 * свободная строка: опечатка не заведёт «новый» сервис.
 *
 * - `fx.*` — источники курсов (`modules/fx/fx.refresher.ts`);
 * - `telegram.bot` — Bot API;
 * - `telegram.web` — публичные страницы Telegram и его CDN: аватарка бота и Mini App для
 *   задания (Р158). Отдельно от `telegram.bot`: это не Bot API и ходит не на его хост,
 *   поэтому у сервиса свой режим маршрута и своя строка в журнале;
 * - `vk.api` — методы API VK ключом сообщества: проверка вступления, ответы игрокам (Р188);
 * - `max.bot` — Bot API MAX: бот заданий-каналов (Р188);
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
  "telegram.web",
  "vk.api",
  "max.bot",
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
