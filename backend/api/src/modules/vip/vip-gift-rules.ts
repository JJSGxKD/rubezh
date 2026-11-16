import { z } from "zod";
import { publicIdSchema } from "../../common/public-identity.js";

/**
 * Правила VIP в подарок другу (docs/35-stage4-plan.md Р155, tasks/T-0249): чистые функции без
 * базы и Nest. Подаренный срок живёт отдельно от подписки: подписка и её продления пишут свой срок
 * (`vip_period`), подарок — свой (`vip_gift`), а VIP идёт, пока идёт хоть один из них.
 *
 * Все моменты — `Date` в UTC, срок складывается в миллисекундах: сутки — ровно 86 400 секунд, без
 * сдвига на летнее время (сервер и база — в UTC, локальное время только на отображении).
 */

const DAY_MS = 86_400_000;

/** Сколько заказов подарка в сутки может сделать один дарящий — рабочее число против злоупотреблений с возвратами. */
export const VIP_GIFT_DAY_LIMIT = 5;

/** Срок одного подарка: начало, конец — не включительно. */
export interface GiftSpan {
  startsAt: Date;
  endsAt: Date;
}

/** Подаренный срок как он лежит в базе; возврат звёзд ставит `revokedAt`. */
export interface GiftWindow extends GiftSpan {
  /** когда вернули звёзды; `null` — подарок в силе */
  revokedAt: Date | null;
}

/**
 * Куда встаёт новый подарок: с «сейчас» либо с конца того, что уже занято, — что позже. Так подарки
 * идут цепочкой без наложений, а у получателя с идущим VIP подарок продлевает его, а не сгорает
 * внутри него. `lastEnd` — конец занятого (`lastEndOf`), `null` — занятого нет.
 */
export function nextGiftWindow(lastEnd: Date | null, at: Date, days: number): GiftSpan {
  if (!Number.isInteger(days) || days <= 0) throw new Error(`срок подарка — целое число суток больше нуля, а не ${String(days)}`);
  const startsAt = lastEnd !== null && lastEnd.getTime() > at.getTime() ? lastEnd : at;
  return { startsAt, endsAt: new Date(startsAt.getTime() + days * DAY_MS) };
}

/**
 * За чем встаёт новый подарок: за концом подписки получателя и за концом самого позднего
 * неотозванного подарка. Отозванный конец не продлевает: возврат бывает только в прошлом, и оборванный
 * подарок уже кончился; а подписку подарок не затирает, он встаёт за её текущим сроком.
 */
export function lastEndOf(subscriptionUntil: Date | null, gifts: readonly GiftWindow[]): Date | null {
  let last = subscriptionUntil;
  for (const gift of gifts) {
    if (gift.revokedAt !== null) continue;
    if (last === null || gift.endsAt.getTime() > last.getTime()) last = gift.endsAt;
  }
  return last;
}

/** Конец подарка с учётом возврата: оборван в момент возврата. Пустой срок (отозван до начала) — `null`. */
function effectiveEnd(gift: GiftWindow): Date | null {
  const end = gift.revokedAt !== null && gift.revokedAt.getTime() < gift.endsAt.getTime() ? gift.revokedAt : gift.endsAt;
  return end.getTime() > gift.startsAt.getTime() ? end : null;
}

/**
 * Идёт ли VIP в момент `at`: подписка не кончилась или идёт неотозванный подарок. Подарок идёт с
 * начала включительно до конца не включительно; отозванный не идёт с момента возврата, а не начавшийся
 * и отозванный — не шёл вовсе.
 */
export function vipActiveAt(subscriptionUntil: Date | null, gifts: readonly GiftWindow[], at: Date): boolean {
  if (subscriptionUntil !== null && subscriptionUntil.getTime() > at.getTime()) return true;
  return gifts.some((gift) => {
    const end = effectiveEnd(gift);
    return end !== null && gift.startsAt.getTime() <= at.getTime() && end.getTime() > at.getTime();
  });
}

/**
 * До какого числа идёт VIP. Идёт сейчас — до конца непрерывной цепочки: подарки, начатые вплотную к
 * концу прежнего, продолжают её, разрыв обрывает. Не идёт — конец последнего срока из уже начатых;
 * подарок, который ещё не начался, за разрывом не в счёт. `null` — VIP не было.
 */
export function vipUntilAt(subscriptionUntil: Date | null, gifts: readonly GiftWindow[], at: Date): Date | null {
  const spans = gifts.flatMap((gift) => {
    const end = effectiveEnd(gift);
    return end === null ? [] : [{ startsAt: gift.startsAt, endsAt: end }];
  });
  if (!vipActiveAt(subscriptionUntil, gifts, at)) {
    let last = subscriptionUntil;
    for (const span of spans) {
      if (span.startsAt.getTime() <= at.getTime() && (last === null || span.endsAt.getTime() > last.getTime())) last = span.endsAt;
    }
    return last;
  }
  let end = subscriptionUntil !== null && subscriptionUntil.getTime() > at.getTime() ? subscriptionUntil : at;
  // Цепочка: каждый круг подтягивает подарки, начатые не позже текущего конца; кругов не больше числа подарков.
  for (let round = 0; round <= spans.length; round += 1) {
    let extended = false;
    for (const span of spans) {
      if (span.startsAt.getTime() <= end.getTime() && span.endsAt.getTime() > end.getTime()) {
        end = span.endsAt;
        extended = true;
      }
    }
    if (!extended) break;
  }
  return end;
}

/** Почему подарок заказать нельзя. */
export type GiftOrderRefusal = "self" | "not_friend" | "blocked";

/**
 * Можно ли дарить: не себе, получатель есть и он друг, и он не заблокирован. Порядок важен: чужим и
 * несуществующим отвечаем одинаково, а блокировка называется только другу — иначе по ответу можно
 * было бы выяснять, кто заблокирован.
 */
export function giftOrderRefusal(input: { self: boolean; found: boolean; friends: boolean; blocked: boolean }): GiftOrderRefusal | null {
  if (input.self) return "self";
  if (!input.found || !input.friends) return "not_friend";
  if (input.blocked) return "blocked";
  return null;
}

/** Тело заказа подарка: ровно публичный id получателя; внутренний `accountId` клиент не присылает. */
export const giftOrderBodySchema = z.object({ publicId: publicIdSchema }).strict();

/** Сколько знаков имени дарящего влезает в строку ленты: схема вида считает кодовые единицы UTF-16. */
export const GIFT_NAME_MAX = 64;

/**
 * Имя дарящего для уведомления: копия на момент выдачи, не длиннее строки ленты и без разорванной пары
 * суррогатов. Пустое имя заменяется, чтобы схема вида его приняла.
 */
export function cutGiverName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return "Друг";
  let result = "";
  for (const symbol of trimmed) {
    if (result.length + symbol.length > GIFT_NAME_MAX) break;
    result += symbol;
  }
  return result;
}

/** Ключ уведомления получателю: одна строка на покупку подарка, повтор выдачи второй не заведёт. */
export function giftNoticeKey(purchaseId: string): string {
  return `vip_gift:${purchaseId}`;
}
