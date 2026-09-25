import { isCurrencyCode, type CurrencyCode } from "../currency.js";
import { Decimal } from "../decimal.js";

/**
 * Реестр способов оплаты (docs/35-stage4-plan.md §3.12, Р33): площадка,
 * провайдер, валюта, пределы, комиссия, доступность, порядок. Способов на
 * площадке может быть несколько — тогда игрок выбирает, и выбор
 * запоминается. Реестр — данные, схема которых проверяется тестом.
 */
export type Platform = "telegram" | "max" | "vk" | "web";
export type DeviceClass = "ios" | "android" | "desktop";

/** Комиссия внутри цены (провайдер удерживает из суммы) или сверху (игрок платит цену плюс комиссию). */
export type FeeMode = "inside" | "on_top";

export interface PaymentMethod {
  id: string;
  platform: Platform;
  /** Провайдер — порт оплаты площадки (§3.11); по нему модуль бэкенда выбирает адаптер. */
  provider: string;
  currency: CurrencyCode;
  /** Пределы суммы в валюте способа; null — провайдер не ограничивает. */
  min: Decimal | null;
  max: Decimal | null;
  fee: { rate: Decimal; mode: FeeMode };
  /** Доля площадки от суммы после комиссии провайдера — для выручки. У звёзд площадка и провайдер — одно лицо, и доля сидит в курсе выручки. */
  platformShare: Decimal;
  /** Пустой список — везде. Коды стран — ISO 3166-1 alpha-2. */
  countries: readonly string[];
  devices: readonly DeviceClass[];
  /** Порядок в списке выбора на площадке. */
  order: number;
  enabled: boolean;
}

export interface MethodContext {
  platform: Platform;
  country?: string;
  device?: DeviceClass;
}

/**
 * Способы старта — рабочие значения (Р31): комиссии и пределы сверяются с
 * договорами провайдеров при подключении. В Telegram цифровые товары — только
 * звёзды (docs/08-web-and-identity.md §6); в вебе — российский эквайринг и
 * СБП для RU, Gram и USDT через TON Connect; в MAX — рубли. VK — с портом на
 * этапе 7: у голосов нет строки в реестре валют.
 */
export const DEFAULT_PAYMENT_METHODS: readonly PaymentMethod[] = [
  { id: "telegram_stars", platform: "telegram", provider: "telegram_stars", currency: "XTR", min: Decimal.of(1), max: Decimal.of(10_000), fee: { rate: Decimal.ZERO, mode: "inside" }, platformShare: Decimal.ZERO, countries: [], devices: [], order: 1, enabled: true },
  { id: "max_rub", platform: "max", provider: "max_payments", currency: "RUB", min: Decimal.of(10), max: Decimal.of(100_000), fee: { rate: Decimal.of("0.05"), mode: "inside" }, platformShare: Decimal.ZERO, countries: [], devices: [], order: 1, enabled: true },
  { id: "web_card_rub", platform: "web", provider: "ru_acquiring", currency: "RUB", min: Decimal.of(10), max: Decimal.of(100_000), fee: { rate: Decimal.of("0.035"), mode: "inside" }, platformShare: Decimal.ZERO, countries: ["RU"], devices: [], order: 1, enabled: true },
  { id: "web_sbp_rub", platform: "web", provider: "ru_sbp", currency: "RUB", min: Decimal.of(10), max: Decimal.of(100_000), fee: { rate: Decimal.of("0.007"), mode: "inside" }, platformShare: Decimal.ZERO, countries: ["RU"], devices: [], order: 2, enabled: true },
  { id: "web_ton_gram", platform: "web", provider: "ton_connect", currency: "GRAM", min: Decimal.of("0.1"), max: null, fee: { rate: Decimal.ZERO, mode: "inside" }, platformShare: Decimal.ZERO, countries: [], devices: [], order: 3, enabled: true },
  { id: "web_ton_usdt", platform: "web", provider: "ton_connect", currency: "USDT", min: Decimal.of("0.5"), max: null, fee: { rate: Decimal.ZERO, mode: "inside" }, platformShare: Decimal.ZERO, countries: [], devices: [], order: 4, enabled: true },
];

export function findPaymentMethodProblems(methods: readonly PaymentMethod[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const orders = new Set<string>();

  for (const method of methods) {
    const where = `способ оплаты ${method.id}`;
    if (ids.has(method.id)) problems.push(`${where}: идентификатор повторяется`);
    ids.add(method.id);
    if (!isCurrencyCode(method.currency)) problems.push(`${where}: неизвестная валюта ${method.currency}`);
    if (method.fee.rate.isNegative() || method.fee.rate.gte(1)) problems.push(`${where}: комиссия должна быть в [0, 1)`);
    if (method.platformShare.isNegative() || method.platformShare.gte(1)) problems.push(`${where}: доля площадки должна быть в [0, 1)`);
    if (method.min && !method.min.isPositive()) problems.push(`${where}: нижний предел должен быть больше нуля`);
    if (method.min && method.max && method.max.lt(method.min)) problems.push(`${where}: верхний предел меньше нижнего`);
    const orderKey = `${method.platform}:${method.order}`;
    if (orders.has(orderKey)) problems.push(`${where}: порядок ${method.order} на площадке ${method.platform} уже занят`);
    orders.add(orderKey);
    for (const country of method.countries) {
      if (!/^[A-Z]{2}$/.test(country)) problems.push(`${where}: код страны ${country} не ISO 3166-1 alpha-2`);
    }
  }
  return problems;
}

/** Доступные игроку способы на площадке — включённые, подходящие по стране и устройству, в порядке показа. */
export function availableMethods(methods: readonly PaymentMethod[], ctx: MethodContext): PaymentMethod[] {
  return methods
    .filter((method) => method.enabled && method.platform === ctx.platform)
    .filter((method) => method.countries.length === 0 || (ctx.country !== undefined && method.countries.includes(ctx.country)))
    .filter((method) => method.devices.length === 0 || (ctx.device !== undefined && method.devices.includes(ctx.device)))
    .sort((a, b) => a.order - b.order);
}
