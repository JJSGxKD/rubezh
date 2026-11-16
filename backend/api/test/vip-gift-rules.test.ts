import { describe, expect, it } from "vitest";
import { NOTIFICATION_KINDS } from "../src/modules/notifications/notification-kinds.js";
import {
  VIP_GIFT_DAY_LIMIT,
  cutGiverName,
  giftNoticeKey,
  giftOrderBodySchema,
  giftOrderRefusal,
  lastEndOf,
  nextGiftWindow,
  vipActiveAt,
  vipUntilAt,
  type GiftWindow,
} from "../src/modules/vip/vip-gift-rules.js";
import { VIP_GIFT_SKU, VIP_PLAN } from "../src/modules/vip/vip-plan.js";

/**
 * Правила VIP в подарок (tasks/T-0249, docs/35-stage4-plan.md Р155): куда встаёт срок подарка,
 * идёт ли VIP при подписке и подарках вместе, кто кому может дарить. Чистые функции — без базы.
 */

const DAY = 86_400_000;
const T0 = new Date(Date.UTC(2026, 10, 20, 9));
const at = (days: number): Date => new Date(T0.getTime() + days * DAY);
const gift = (from: number, to: number, revokedAt: number | null = null): GiftWindow => ({ startsAt: at(from), endsAt: at(to), revokedAt: revokedAt === null ? null : at(revokedAt) });

describe("позиция подарка и срок", () => {
  it("цена — как месяц подписки, срок — её период", () => {
    expect(VIP_GIFT_SKU.stars).toBe(VIP_PLAN.stars);
    expect(VIP_GIFT_SKU.days).toBe(VIP_PLAN.periodDays);
    expect(VIP_GIFT_SKU.sku).toBe("vip_gift");
  });

  it("пять заказов в сутки на дарящего", () => {
    expect(VIP_GIFT_DAY_LIMIT).toBe(5);
  });
});

describe("nextGiftWindow: подарок без VIP — с «сейчас» на 30 дней", () => {
  it("ничего нет — с момента выдачи", () => {
    expect(nextGiftWindow(null, T0, 30)).toEqual({ startsAt: T0, endsAt: at(30) });
  });

  it("прежний срок давно кончился — тоже с момента выдачи, а не с прошлого конца", () => {
    expect(nextGiftWindow(at(-40), T0, 30)).toEqual({ startsAt: T0, endsAt: at(30) });
  });

  it("прежний срок кончился ровно сейчас — с этого момента", () => {
    expect(nextGiftWindow(T0, T0, 30)).toEqual({ startsAt: T0, endsAt: at(30) });
  });

  it("второй подарок встаёт после первого", () => {
    expect(nextGiftWindow(at(30), T0, 30)).toEqual({ startsAt: at(30), endsAt: at(60) });
  });

  it("третий — после второго, и подарки не пересекаются", () => {
    const first = nextGiftWindow(null, T0, 30);
    const second = nextGiftWindow(first.endsAt, T0, 30);
    const third = nextGiftWindow(second.endsAt, T0, 30);
    expect([first, second, third].map((window) => [window.startsAt.getTime(), window.endsAt.getTime()])).toEqual([
      [T0.getTime(), at(30).getTime()],
      [at(30).getTime(), at(60).getTime()],
      [at(60).getTime(), at(90).getTime()],
    ]);
  });

  it("срок складывается в миллисекундах UTC, без перехода на летнее время", () => {
    const winter = new Date(Date.UTC(2026, 9, 25, 0, 0, 0, 123));
    expect(nextGiftWindow(null, winter, 30).endsAt.getTime() - winter.getTime()).toBe(30 * DAY);
  });

  it("срок не бывает нулевым или отрицательным", () => {
    expect(() => nextGiftWindow(null, T0, 0)).toThrow();
    expect(() => nextGiftWindow(null, T0, -3)).toThrow();
    expect(() => nextGiftWindow(null, T0, 1.5)).toThrow();
  });
});

describe("lastEndOf: за чем встаёт новый подарок", () => {
  it("ни подписки, ни подарков — нет конца", () => {
    expect(lastEndOf(null, [])).toBeNull();
  });

  it("подписка — её конец; подарок позже подписки — его конец", () => {
    expect(lastEndOf(at(10), [])).toEqual(at(10));
    expect(lastEndOf(at(10), [gift(10, 40)])).toEqual(at(40));
    expect(lastEndOf(at(50), [gift(0, 30)])).toEqual(at(50));
  });

  it("отозванный подарок конец не продлевает", () => {
    expect(lastEndOf(null, [gift(0, 30, 5)])).toBeNull();
    expect(lastEndOf(at(10), [gift(10, 40, 12)])).toEqual(at(10));
  });

  it("подарки идут в любом порядке: берётся самый поздний конец", () => {
    expect(lastEndOf(null, [gift(30, 60), gift(0, 30), gift(60, 90)])).toEqual(at(90));
  });
});

describe("vipActiveAt: подписка или идущий подарок", () => {
  it("подписка идёт — VIP активен, подарков нет", () => {
    expect(vipActiveAt(at(5), [], T0)).toBe(true);
  });

  it("подписка кончилась ровно сейчас — уже нет", () => {
    expect(vipActiveAt(T0, [], T0)).toBe(false);
  });

  it("подписка истекла, подарок идёт — активен", () => {
    expect(vipActiveAt(at(-1), [gift(-5, 25)], T0)).toBe(true);
  });

  it("оба кончились — нет", () => {
    expect(vipActiveAt(at(-10), [gift(-40, -10)], T0)).toBe(false);
    expect(vipActiveAt(null, [], T0)).toBe(false);
  });

  it("подарок ещё не начался — VIP не идёт, а начало — включительно", () => {
    expect(vipActiveAt(null, [gift(10, 40)], T0)).toBe(false);
    expect(vipActiveAt(null, [gift(10, 40)], at(10))).toBe(true);
  });

  it("конец подарка — не включительно", () => {
    expect(vipActiveAt(null, [gift(0, 30)], at(30))).toBe(false);
    expect(vipActiveAt(null, [gift(0, 30)], new Date(at(30).getTime() - 1))).toBe(true);
  });

  it("отозванный подарок — не в счёт", () => {
    expect(vipActiveAt(null, [gift(-5, 25, -5)], T0)).toBe(false);
    expect(vipActiveAt(null, [gift(0, 30, 0)], T0)).toBe(false);
    expect(vipActiveAt(null, [gift(10, 40, 2)], at(15))).toBe(false);
  });

  it("подарок отозван посреди срока: до отзыва VIP шёл, после — нет", () => {
    const window = gift(0, 30, 10);
    expect(vipActiveAt(null, [window], at(9))).toBe(true);
    expect(vipActiveAt(null, [window], at(10))).toBe(false);
    expect(vipActiveAt(null, [window], at(20))).toBe(false);
  });

  it("первый подарок отозван до начала, второй не сдвинулся: в промежутке VIP нет", () => {
    const gifts = [gift(0, 30, 5), gift(30, 60)];
    expect(vipActiveAt(null, gifts, at(10))).toBe(false);
    expect(vipActiveAt(null, gifts, at(31))).toBe(true);
  });
});

describe("vipUntilAt: до какого числа идёт VIP", () => {
  it("ни подписки, ни подарков — нет", () => {
    expect(vipUntilAt(null, [], T0)).toBeNull();
  });

  it("идёт только подписка — её конец", () => {
    expect(vipUntilAt(at(7), [], T0)).toEqual(at(7));
  });

  it("подарки встали за подпиской цепочкой — конец последнего", () => {
    expect(vipUntilAt(at(10), [gift(10, 40), gift(40, 70)], T0)).toEqual(at(70));
  });

  it("между подарками разрыв — идёт только до разрыва", () => {
    expect(vipUntilAt(null, [gift(-5, 25), gift(40, 70)], T0)).toEqual(at(25));
  });

  it("VIP кончился — конец последнего из закончившихся; будущий подарок за разрывом не в счёт", () => {
    expect(vipUntilAt(at(-20), [gift(-30, -10), gift(20, 50)], T0)).toEqual(at(-10));
    expect(vipUntilAt(at(-20), [], T0)).toEqual(at(-20));
  });

  it("отозванный подарок не продлевает: до отзыва он шёл", () => {
    expect(vipUntilAt(null, [gift(-5, 25, 3)], at(1))).toEqual(at(3));
    expect(vipUntilAt(null, [gift(-5, 25, 3)], at(10))).toEqual(at(3));
    expect(vipUntilAt(null, [gift(10, 40, 2)], T0)).toBeNull();
  });
});

describe("кто кому может дарить", () => {
  const base = { self: false, found: true, friends: true, blocked: false };

  it("друг, не себе, не заблокирован — можно", () => {
    expect(giftOrderRefusal(base)).toBeNull();
  });

  it("не друг и несуществующий отвечают одинаково", () => {
    expect(giftOrderRefusal({ ...base, friends: false })).toBe("not_friend");
    expect(giftOrderRefusal({ ...base, found: false, friends: false })).toBe("not_friend");
  });

  it("себе — отказ, раньше всех остальных", () => {
    expect(giftOrderRefusal({ ...base, self: true })).toBe("self");
    expect(giftOrderRefusal({ ...base, self: true, friends: false })).toBe("self");
  });

  it("заблокированному — отказ, но не-другу блокировку не раскрываем", () => {
    expect(giftOrderRefusal({ ...base, blocked: true })).toBe("blocked");
    expect(giftOrderRefusal({ ...base, blocked: true, friends: false })).toBe("not_friend");
  });
});

describe("тело заказа, имя в уведомлении и ключ", () => {
  it("тело — ровно публичный id: 12 строчных hex-знаков", () => {
    expect(giftOrderBodySchema.safeParse({ publicId: "0123456789ab" }).success).toBe(true);
    for (const publicId of ["0123456789a", "0123456789abc", "0123456789AB", "0123456789ag", "", 5]) {
      expect(giftOrderBodySchema.safeParse({ publicId }).success, String(publicId)).toBe(false);
    }
    expect(giftOrderBodySchema.safeParse({}).success).toBe(false);
  });

  it("лишние поля отвергаются: получатель только по публичному id, accountId не принимается", () => {
    expect(giftOrderBodySchema.safeParse({ publicId: "0123456789ab", accountId: "11111111-1111-4111-8111-111111111111" }).success).toBe(false);
    expect(giftOrderBodySchema.safeParse({ publicId: "0123456789ab", recipient: "x" }).success).toBe(false);
  });

  it("имя дарящего влезает в уведомление и не рвёт пару суррогатов", () => {
    expect(cutGiverName("Друг")).toBe("Друг");
    expect(cutGiverName("я".repeat(100))).toHaveLength(64);
    // Схема уведомления считает кодовые единицы UTF-16: пара суррогатов — две, и разрывать её нельзя.
    const emoji = "🙂".repeat(80);
    expect(cutGiverName(emoji).length).toBeLessThanOrEqual(64);
    expect([...cutGiverName(emoji)].length).toBeGreaterThan(0);
    expect(cutGiverName(emoji)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(cutGiverName("a" + "🙂".repeat(80)).length).toBeLessThanOrEqual(64);
    expect(NOTIFICATION_KINDS.vip_gift.safeParse({ fromName: cutGiverName(emoji), days: 30 }).success).toBe(true);
  });

  it("пустое имя заменяется, чтобы схема уведомления его приняла", () => {
    expect(cutGiverName("")).not.toBe("");
    expect(NOTIFICATION_KINDS.vip_gift.safeParse({ fromName: cutGiverName("   "), days: 30 }).success).toBe(true);
  });

  it("ключ уведомления — по покупке: повтор выдачи второй строки не заведёт", () => {
    expect(giftNoticeKey("11111111-1111-4111-8111-111111111111")).toBe("vip_gift:11111111-1111-4111-8111-111111111111");
    expect(giftNoticeKey("a")).not.toBe(giftNoticeKey("b"));
  });

  it("вид уведомления: имя и число дней, больше ничего", () => {
    expect(NOTIFICATION_KINDS.vip_gift.safeParse({ fromName: "Друг", days: 30 }).success).toBe(true);
    expect(NOTIFICATION_KINDS.vip_gift.safeParse({ fromName: "Друг" }).success).toBe(false);
    expect(NOTIFICATION_KINDS.vip_gift.safeParse({ fromName: "", days: 30 }).success).toBe(false);
    expect(NOTIFICATION_KINDS.vip_gift.safeParse({ fromName: "Друг", days: 0 }).success).toBe(false);
  });
});
