import { Decimal } from "@bh/fx";

/**
 * Месяц проекта для кабинета участника (docs/35-stage4-plan.md Р218, tasks/T-0453): чистые расчёты без Nest и
 * Prisma — выручка живыми оплатами месяца без возвращённых, холд, деньги вниз до цента и копейки, черновик
 * части. Ядра учёта ещё нет (`docs/37-accounting.md`), поэтому это честная оценка «до расходов и налога», а не
 * итог закрытого периода.
 *
 * Деньги — `Decimal`: промежуточные суммы не округляются, округление вниз — один раз, на выходе. Вниз, чтобы не
 * обещать больше, чем есть; рубли считаются от точных долларов, а не от уже округлённых до цента.
 */

const DAY_MS = 86_400_000;

export type Platform = "telegram" | "max" | "vk" | "web";
export type PurchaseKind = "continue_run" | "shop_item" | "vip" | "donation";
export type RevenueSource = "shop" | "continue" | "vip" | "donation";

/** Строка живой оплаты месяца: только то, что нужно расчёту. */
export interface PurchaseRow {
  chargedStars: number;
  paidAt: Date;
  /** `null` — не возвращена */
  refundedAt: Date | null;
  product: PurchaseKind;
  /** площадка аккаунта покупателя */
  platform: Platform;
}

/** Курсы: звезда → доллар по курсу выплаты, доллар → рубль. */
export interface ProjectMonthRate {
  starUsd: Decimal;
  usdRub: Decimal;
}

export interface ProjectMonthInput {
  purchases: readonly PurchaseRow[];
  holdDays: number;
  now: Date;
  /** `null` — курса выплаты звезды или рубля нет: денежных сумм не будет */
  rates: ProjectMonthRate | null;
  /** доля смотрящего в базисных пунктах; `null` — доли нет */
  shareBp: number | null;
}

export interface ProjectMonth {
  revenue: {
    stars: { paid: number; refunded: number; net: number };
    /** без нулевых, по убыванию */
    byPlatform: { platform: Platform; net: number }[];
    bySource: { source: RevenueSource; net: number }[];
    /** `"123.45"`; `null` — курса нет */
    usd: string | null;
    rub: string | null;
  };
  hold: { days: number; inHoldStars: number; releasedStars: number; nextReleaseAt: string | null };
  draft: { sharePercent: number; usd: string | null; rub: string | null; stars: number } | null;
}

const SOURCE_OF: Record<PurchaseKind, RevenueSource> = {
  shop_item: "shop",
  continue_run: "continue",
  vip: "vip",
  donation: "donation",
};

/** Сумма вниз до сотых: цент и копейка — одним правилом. */
function cents(value: Decimal): string {
  return value.toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed(2);
}

/** Разбивка по ключу: нулевые отбрасываются, порядок — по убыванию, при равенстве по ключу (стабильно между запросами). */
function breakdown<K extends string>(totals: ReadonlyMap<K, number>): { key: K; net: number }[] {
  return [...totals.entries()]
    .filter(([, net]) => net > 0)
    .map(([key, net]) => ({ key, net }))
    .sort((a, b) => b.net - a.net || (a.key < b.key ? -1 : 1));
}

export function projectMonth(input: ProjectMonthInput): ProjectMonth {
  const { purchases, holdDays, now, rates, shareBp } = input;
  const holdMs = holdDays * DAY_MS;

  let paid = 0;
  let refunded = 0;
  let inHoldStars = 0;
  let releasedStars = 0;
  let nextRelease: number | null = null;
  const byPlatform = new Map<Platform, number>();
  const bySource = new Map<RevenueSource, number>();

  for (const purchase of purchases) {
    paid += purchase.chargedStars;
    // Возвращённая оплата — не наша: ни в чистой выручке, ни в холде
    if (purchase.refundedAt !== null) {
      refunded += purchase.chargedStars;
      continue;
    }
    byPlatform.set(purchase.platform, (byPlatform.get(purchase.platform) ?? 0) + purchase.chargedStars);
    const source = SOURCE_OF[purchase.product];
    bySource.set(source, (bySource.get(source) ?? 0) + purchase.chargedStars);

    // Холд кончается ровно через `holdDays` суток после оплаты: в эту секунду звёзды уже вышли
    const releaseAt = purchase.paidAt.getTime() + holdMs;
    if (releaseAt > now.getTime()) {
      inHoldStars += purchase.chargedStars;
      if (nextRelease === null || releaseAt < nextRelease) nextRelease = releaseAt;
    } else {
      releasedStars += purchase.chargedStars;
    }
  }

  const net = paid - refunded;
  const usd = rates === null ? null : new Decimal(net).mul(rates.starUsd);

  let draft: ProjectMonth["draft"] = null;
  if (shareBp !== null && shareBp > 0) {
    const part = usd === null ? null : usd.mul(shareBp).div(10_000);
    draft = {
      sharePercent: shareBp / 100,
      usd: part === null ? null : cents(part),
      rub: part === null || rates === null ? null : cents(part.mul(rates.usdRub)),
      stars: new Decimal(net).mul(shareBp).div(10_000).toDecimalPlaces(0, Decimal.ROUND_DOWN).toNumber(),
    };
  }

  return {
    revenue: {
      stars: { paid, refunded, net },
      byPlatform: breakdown(byPlatform).map(({ key, net: value }) => ({ platform: key, net: value })),
      bySource: breakdown(bySource).map(({ key, net: value }) => ({ source: key, net: value })),
      usd: usd === null ? null : cents(usd),
      rub: usd === null || rates === null ? null : cents(usd.mul(rates.usdRub)),
    },
    hold: { days: holdDays, inHoldStars, releasedStars, nextReleaseAt: nextRelease === null ? null : new Date(nextRelease).toISOString() },
    draft,
  };
}

/** Следующий месяц `ГГГГ-ММ`: конец отрезка «с первого числа до первого числа следующего». */
export function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  return index === 12 ? `${String(year + 1).padStart(4, "0")}-01` : `${month.slice(0, 5)}${String(index + 1).padStart(2, "0")}`;
}

/**
 * Месяцы от первого до текущего, новые сверху. Первый месяц позже текущего (часы ушли назад, оплата «из будущего») —
 * только текущий: список не должен предлагать месяц, который сервис потом откажется открыть.
 */
export function monthsFromFirst(first: string, current: string): string[] {
  const months: string[] = [];
  for (let month = first <= current ? first : current; month <= current; month = nextMonth(month)) months.push(month);
  return months.reverse();
}
