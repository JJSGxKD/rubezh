import { Decimal, fromMinorUnits, isCurrencyCode } from "@bh/fx";
import type { AccountType, WaterfallLine } from "@bh/ledger";
import type { RateOnDate, RateQuery } from "../../fx/fx-history.js";

/**
 * Факты месяца учёта для закрытия (docs/37-accounting.md §13, Р222, tasks/T-0468): какие счета входят в водопад,
 * как каждая проводка оценивается по курсу своего дня и как из чеков считается налог НПД. Чистые функции без Nest,
 * Prisma и базы: строки месяца и ответы ядра курсов приходят аргументами, поэтому всё считается в тесте.
 */

/** Откуда берётся строка водопада: выручка по площадкам и источникам, прочие поступления или расходы. */
export type FactGroup = "revenue" | "income" | "expense";

/**
 * Строка проводки месяца по счёту выручки, поступлений или расходов. `minor` — со знаком журнала (дебет плюс,
 * кредит минус), в минимальных единицах валюты счёта; `at` — момент проводки: курс берётся на него.
 */
export interface FactLine {
  accountId: string;
  accountName: string;
  type: AccountType;
  currency: string;
  at: Date;
  minor: bigint;
}

/**
 * Группа водопада по счёту. Решает и тип, и устройство id: `revenue.<площадка>.<…>` — выручка, `income.<статья>.<валюта>` —
 * прочие поступления (оба типа «выручка»), `expense.…` — расходы. Начисленный закрытием налог в расходы водопада не
 * входит: налог в нём отдельный шаг, а закрытие после снятия считает его заново.
 */
export function groupOf(accountId: string, type: AccountType): FactGroup | null {
  if (type === "revenue" && accountId.startsWith("revenue.")) return "revenue";
  if (type === "revenue" && accountId.startsWith("income.")) return "income";
  if (type === "expense" && accountId.startsWith("expense.") && !accountId.startsWith("expense.tax_accrued.")) return "expense";
  return null;
}

/** День по UTC, «ГГГГ-ММ-ДД»: так курс называется в чек-листе. */
export function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function rateKey(currency: string, at: Date): string {
  return `${currency}|${String(at.getTime())}`;
}

/** Ответы ядра курсов по запросам: ключ — `rateKey`; `null` или отсутствие — курса на дату нет. */
export type RateLookup = ReadonlyMap<string, RateOnDate | null>;

/**
 * Запросы курсов для пакетного вызова ядра: по одному на валюту и момент, только по строкам водопада и только по
 * валютам справочника курсов (чужую валюту спросить не у кого — `valueLines` назовёт её «нет курса»). `extra` —
 * то, что нужно закрытию помимо проводок: рубль и валюты займов на день закрытия.
 */
export function rateQueries(lines: readonly FactLine[], extra: readonly RateQuery[]): RateQuery[] {
  const unique = new Map<string, RateQuery>();
  const add = (query: RateQuery) => {
    const key = rateKey(query.currency, query.at);
    if (!unique.has(key)) unique.set(key, query);
  };
  for (const line of lines) {
    if (groupOf(line.accountId, line.type) === null || !isCurrencyCode(line.currency)) continue;
    add({ currency: line.currency, at: line.at });
  }
  for (const query of extra) add(query);
  return [...unique.values()];
}

/** Валюта и день, на которые нет курса или курс устарел. */
export interface DatedRate {
  currency: string;
  day: string;
}

/**
 * Сумма одного счёта по одному действовавшему курсу. `minor` — со стороны счёта: у выручки и поступлений плюс — это
 * доход, у расходов плюс — это расход; обратный знак — возврат или сторно. `rateAt` — когда принят курс: так корзины
 * одного курса склеиваются, а снимок закрытия помнит курс по строке, а не по каждой проводке.
 */
export interface ValuedBucket {
  accountId: string;
  accountName: string;
  group: FactGroup;
  currency: string;
  /** цена единицы валюты в долларах, десятичной строкой */
  usdPerUnit: string;
  rateAt: string;
  stale: boolean;
  minor: bigint;
}

/** Что нужно, чтобы оценить корзину: из снимка закрытия корзина читается без имени счёта. */
export type BucketCore = Pick<ValuedBucket, "accountId" | "group" | "currency" | "usdPerUnit" | "minor">;

export interface Valuation {
  buckets: ValuedBucket[];
  /** на эти дни курса нет — блокер закрытия */
  missing: DatedRate[];
  /** курс был, но старше недели до даты проводки — предупреждение */
  stale: DatedRate[];
}

const byDayThenCurrency = (a: DatedRate, b: DatedRate): number => (a.day === b.day ? a.currency.localeCompare(b.currency) : a.day.localeCompare(b.day));

/**
 * Оценка проводок месяца: каждая строка водопада — по курсу своего момента. Строки одного счёта с одним и тем же
 * курсом складываются в корзину; нет курса — строка в доллары не превращается, а попадает в `missing`, чтобы
 * закрытие остановил блокер, а не молчаливый ноль.
 */
export function valueLines(lines: readonly FactLine[], rates: RateLookup): Valuation {
  const buckets = new Map<string, ValuedBucket>();
  const missing = new Map<string, DatedRate>();
  const stale = new Map<string, DatedRate>();
  for (const line of lines) {
    const group = groupOf(line.accountId, line.type);
    if (group === null) continue;
    const day = dayOf(line.at);
    const rate = rates.get(rateKey(line.currency, line.at));
    if (rate === undefined || rate === null) {
      missing.set(`${line.currency}|${day}`, { currency: line.currency, day });
      continue;
    }
    if (rate.stale) stale.set(`${line.currency}|${day}`, { currency: line.currency, day });
    const usdPerUnit = rate.usdPerUnit.toFixed();
    const rateAt = rate.at.toISOString();
    const key = `${line.accountId}|${line.currency}|${usdPerUnit}|${rateAt}`;
    const side = group === "expense" ? line.minor : -line.minor;
    const found = buckets.get(key);
    if (found === undefined) {
      buckets.set(key, { accountId: line.accountId, accountName: line.accountName, group, currency: line.currency, usdPerUnit, rateAt, stale: rate.stale, minor: side });
    } else {
      found.minor += side;
      found.stale = found.stale || rate.stale;
    }
  }
  return {
    buckets: [...buckets.values()].sort((a, b) => a.accountId.localeCompare(b.accountId) || a.rateAt.localeCompare(b.rateAt) || a.currency.localeCompare(b.currency)),
    missing: [...missing.values()].sort(byDayThenCurrency),
    stale: [...stale.values()].sort(byDayThenCurrency),
  };
}

/** Остаток строки в центах доллара, точно: курс — десятичная дробь, и округляется только итог счёта. */
export function usdCentsOf(bucket: Pick<BucketCore, "currency" | "usdPerUnit" | "minor">): Decimal {
  if (!isCurrencyCode(bucket.currency)) throw new Error(`Валюта «${bucket.currency}» не входит в справочник курсов`);
  return fromMinorUnits(bucket.minor, bucket.currency).mul(new Decimal(bucket.usdPerUnit)).mul(100);
}

/** Центы целым, в нужную сторону: «вниз» для дохода, «вверх» для расхода — прибыль не завышается на долю цента. */
export function wholeCents(value: Decimal, mode: "down" | "up"): bigint {
  return BigInt(value.toDecimalPlaces(0, mode === "down" ? Decimal.ROUND_DOWN : Decimal.ROUND_UP).toFixed(0));
}

export interface WaterfallLines {
  revenue: WaterfallLine[];
  otherIncome: WaterfallLine[];
  expenses: WaterfallLine[];
}

const byKey = (a: WaterfallLine, b: WaterfallLine): number => a.key.localeCompare(b.key);

/**
 * Строки водопада в центах доллара. Счёт оценивается целиком — сумма его корзин, а не округление каждой проводки, —
 * и округляется в сторону осторожности: доходы вниз, расходы вверх. Водопад принимает только неотрицательные
 * суммы, поэтому счёт, у которого итог ушёл за ноль (возвратов больше продаж, сторно расхода), переезжает
 * на противоположную сторону под ключом `contra:<счёт>`: прибыль от этого не меняется, а месяц не встаёт на
 * исключении ядра.
 */
export function waterfallLines(buckets: readonly BucketCore[]): WaterfallLines {
  const totals = new Map<string, { group: FactGroup; cents: Decimal }>();
  for (const bucket of buckets) {
    const found = totals.get(bucket.accountId);
    const cents = usdCentsOf(bucket);
    if (found === undefined) totals.set(bucket.accountId, { group: bucket.group, cents });
    else found.cents = found.cents.add(cents);
  }
  const result: WaterfallLines = { revenue: [], otherIncome: [], expenses: [] };
  for (const [accountId, { group, cents }] of totals) {
    if (cents.isZero()) continue;
    const negative = cents.isNegative();
    const magnitude = cents.abs();
    if (group === "expense") {
      if (!negative) result.expenses.push({ key: accountId, amount: wholeCents(magnitude, "up") });
      else result.otherIncome.push({ key: `contra:${accountId}`, amount: wholeCents(magnitude, "down") });
    } else if (!negative) {
      (group === "revenue" ? result.revenue : result.otherIncome).push({ key: accountId, amount: wholeCents(magnitude, "down") });
    } else {
      result.expenses.push({ key: `contra:${accountId}`, amount: wholeCents(magnitude, "up") });
    }
  }
  for (const lines of [result.revenue, result.otherIncome, result.expenses]) {
    lines.sort(byKey);
    // ноль после округления (доля цента) в строки не идёт: ядро водопада принимает его, а отчёту он ни к чему
    for (let index = lines.length - 1; index >= 0; index -= 1) if (lines[index]?.amount === 0n) lines.splice(index, 1);
  }
  return result;
}

/** Кто платит по чеку: от него зависит ставка НПД (Р221). */
export type ReceiptPayer = "individual" | "legal";

/** Чек НПД: рублёвое зачисление, у которого указан плательщик (`meta.receiptPayer` проводки операции). */
export interface Receipt {
  entryId: string;
  sourceKey: string;
  at: Date;
  period: string;
  payer: ReceiptPayer;
  /** зачислено рублей, в копейках */
  rubMinor: bigint;
  number: string | null;
  link: string | null;
}

export interface NpdRates {
  individualBp: number;
  legalBp: number;
}

export interface NpdPayerTax {
  payer: ReceiptPayer;
  rubMinor: bigint;
  bp: number;
  taxMinor: bigint;
}

const BASIS_POINTS = 10_000n;

/**
 * Налог периода = сумма чеков × ставка плательщика (Р221). Считается по плательщикам, а не по каждому чеку, и
 * округляется вверх до копейки: обязательство не занижается. Чеков нет — налога нет.
 */
export function npdTax(receipts: readonly Pick<Receipt, "payer" | "rubMinor">[], rates: NpdRates): { byPayer: NpdPayerTax[]; taxMinor: bigint } {
  const byPayer: NpdPayerTax[] = [];
  let taxMinor = 0n;
  for (const [payer, bp] of [["individual", rates.individualBp], ["legal", rates.legalBp]] as const) {
    const mine = receipts.filter((receipt) => receipt.payer === payer);
    if (mine.length === 0) continue;
    const rubMinor = mine.reduce((sum, receipt) => sum + receipt.rubMinor, 0n);
    const tax = (rubMinor * BigInt(bp) + BASIS_POINTS - 1n) / BASIS_POINTS;
    byPayer.push({ payer, rubMinor, bp, taxMinor: tax });
    taxMinor += tax;
  }
  return { byPayer, taxMinor };
}
