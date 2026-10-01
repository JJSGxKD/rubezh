import { z } from "zod";

/**
 * Акции магазина (docs/35-stage4-plan.md WP10, часть 8): настоящая скидка от
 * цены каталога на срок, с отсчётом у игрока.
 *
 * **Прежняя цена обязана быть настоящей.** Зачёркнутая цена — это цена
 * каталога, по которой товар продавался до акции, а не придуманная для
 * красоты (ЗоЗПП, закон о рекламе; там же, часть 7). Отсюда пределы:
 * - акция не дольше `maxDays` — иначе скидочная цена и есть обычная, а
 *   зачёркнутая уже не «прежняя»;
 * - между акциями одного товара полная цена стоит не меньше `restDays` —
 *   «вечная распродажа» с перерывом на день делает то же самое;
 * - процент на ярлыке — фактическая скидка, округлённая вниз: обещать больше,
 *   чем списали, нельзя, а меньше — можно.
 *
 * Пределы держит и база (миграция `shop_promo`): строка в обход сервиса не
 * заведёт ни «−100%», ни акцию, кончившуюся до начала.
 */
export const PROMO_LIMITS = {
  minPercent: 5,
  maxPercent: 80,
  /** самая короткая акция: короче — опечатка, а не акция */
  minHours: 1,
  maxDays: 14,
  restDays: 14,
  /** дальше вперёд не заводится: к тому времени цена каталога может поменяться */
  aheadDays: 60,
} as const;

/** Подпись баннера — одна строка на телефоне шириной 360. */
export const PROMO_TITLE_MAX = 48;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** запас на часы панели: «начать сейчас» доходит до сервера через секунды */
const PAST_GRACE_MS = 5 * 60_000;

const moment = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

export const promoInputSchema = z
  .object({
    sku: z.string().min(1).max(32),
    percent: z.number().int().min(PROMO_LIMITS.minPercent).max(PROMO_LIMITS.maxPercent),
    startsAt: moment,
    endsAt: moment,
    title: z
      .string()
      .trim()
      .max(PROMO_TITLE_MAX)
      .nullable()
      .transform((title) => (title === null || title === "" ? null : title)),
  })
  .strict();

export type PromoInput = z.infer<typeof promoInputSchema>;

export interface PromoRow {
  promoId: string;
  sku: string;
  percent: number;
  startsAt: Date;
  endsAt: Date;
  title: string | null;
  createdAt: Date;
  createdBy: string;
  cancelledAt: Date | null;
  cancelledBy: string | null;
}

/** Где акция сейчас: в панели — колонкой, у игрока — только `active`. */
export type PromoState = "scheduled" | "active" | "ended" | "cancelled";

/**
 * Когда акция кончилась или кончится на самом деле: снятая раньше срока —
 * в момент снятия. Снятая до начала не шла вовсе — `null`.
 */
export function effectiveEnd(promo: Pick<PromoRow, "startsAt" | "endsAt" | "cancelledAt">): Date | null {
  if (promo.cancelledAt === null) return promo.endsAt;
  if (promo.cancelledAt <= promo.startsAt) return null;
  return promo.cancelledAt < promo.endsAt ? promo.cancelledAt : promo.endsAt;
}

export function promoState(promo: PromoRow, at: Date): PromoState {
  const end = effectiveEnd(promo);
  if (end === null) return "cancelled";
  if (at < promo.startsAt) return "scheduled";
  if (at < end) return "active";
  return promo.cancelledAt !== null && promo.cancelledAt < promo.endsAt ? "cancelled" : "ended";
}

/** Цена со скидкой: вниз до целой звезды, но не ниже одной. */
export function promoPrice(full: number, percent: number): number {
  return Math.max(1, Math.floor((full * (100 - percent)) / 100));
}

/**
 * Скидка, которую видит игрок: фактическая, округлённая вниз. Округление
 * цены вниз делает её не меньше заявленной; `0` — скидки не вышло (товар за
 * одну звезду), и ярлыка не будет.
 */
export function shownPercent(full: number, price: number): number {
  if (full <= 0 || price >= full) return 0;
  return Math.floor(((full - price) * 100) / full);
}

export type PromoProblem =
  | { code: "promo_period"; message: string }
  | { code: "promo_overlap"; message: string; conflict: PromoRow };

/**
 * Что не так с новой акцией относительно часов и уже заведённых акций того
 * же товара; `null` — можно заводить. Снятая до начала акция не мешает:
 * её не было.
 */
export function promoProblem(input: Pick<PromoInput, "startsAt" | "endsAt">, existing: readonly PromoRow[], at: Date): PromoProblem | null {
  const { startsAt, endsAt } = input;
  const length = endsAt.getTime() - startsAt.getTime();
  if (startsAt.getTime() < at.getTime() - PAST_GRACE_MS) return { code: "promo_period", message: "Акция не начинается в прошлом" };
  if (startsAt.getTime() > at.getTime() + PROMO_LIMITS.aheadDays * DAY_MS) return { code: "promo_period", message: `Акцию заводят не дальше чем за ${String(PROMO_LIMITS.aheadDays)} дней` };
  if (length < PROMO_LIMITS.minHours * HOUR_MS) return { code: "promo_period", message: `Акция идёт не меньше ${String(PROMO_LIMITS.minHours)} ч` };
  if (length > PROMO_LIMITS.maxDays * DAY_MS) return { code: "promo_period", message: `Акция идёт не дольше ${String(PROMO_LIMITS.maxDays)} дней — иначе прежняя цена уже не прежняя` };
  const rest = PROMO_LIMITS.restDays * DAY_MS;
  for (const promo of existing) {
    const end = effectiveEnd(promo);
    if (end === null) continue;
    // Отрезки, раздвинутые на отдых, пересекаются — полная цена между ними не простояла положенного.
    if (startsAt.getTime() < end.getTime() + rest && promo.startsAt.getTime() < endsAt.getTime() + rest) {
      return {
        code: "promo_overlap",
        message: `У товара уже есть акция рядом по времени: между акциями полная цена стоит не меньше ${String(PROMO_LIMITS.restDays)} дней`,
        conflict: promo,
      };
    }
  }
  return null;
}

/**
 * Что игрок видит и платит по акции: цена и фактическая скидка. `null` —
 * акции нет, способ оплаты товар не продаёт или скидки не вышло.
 */
export function promoOffer(full: number | null, promo: Pick<PromoRow, "percent"> | undefined): { price: number; percent: number } | null {
  if (full === null || promo === undefined) return null;
  const price = promoPrice(full, promo.percent);
  const percent = shownPercent(full, price);
  return percent === 0 ? null : { price, percent };
}
