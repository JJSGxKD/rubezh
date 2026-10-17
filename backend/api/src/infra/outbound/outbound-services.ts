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
 * - `secrets.check` — проверка ключа интеграции из панели.
 */
export const OUTBOUND_SERVICES = [
  "fx.cbr",
  "fx.ecb",
  "fx.erapi",
  "fx.coingecko",
  "fx.tonapi",
  "fx.binance",
  "telegram.bot",
  "taddy.api",
  "taddy.exchange",
  "ads.creatives",
  "ads.postback",
  "secrets.check",
] as const;

export type OutboundService = (typeof OUTBOUND_SERVICES)[number];
