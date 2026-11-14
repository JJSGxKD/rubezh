import { reverse } from "@bh/ledger";
import type { LedgerPostInput } from "./ledger.service.js";

/**
 * Проводки из платежей (docs/37-accounting.md §4, §5, §8; Р219, tasks/T-0458): чистые правила без базы и Nest.
 * Покупка плюс то, что уже проведено, на входе — список проводок, которые нужно провести сейчас, в правильном
 * порядке. Что именно записано в журнале, узнаёт репозиторий; здесь только решение.
 *
 * Три проводки жизни оплаты звёздами, ключи источника — `purchase:<id>:paid|release|refund`:
 * - оплата: «в холде» плюс, выручка по статье минус, срок выхода из холда записан в `meta.releaseAt`;
 * - выход: «в холде» минус, «доступно» плюс, на дату срока;
 * - возврат: до срока — сторно оплаты, после — «доступно» минус и выручка плюс.
 *
 * Порядок холда и возврата решают даты, а не то, когда сработало задание: возврат раньше срока выхода — выхода
 * из холда не будет никогда. Исключение одно, и оно про уже проведённое: если «выход» уже в журнале, возврат
 * идёт из «доступно» при любой дате (о возврате узнали задним числом) — сторно оплаты увело бы холд в минус.
 */

const DAY_MS = 86_400_000;

/** Звёзды бота в двух состояниях (план счетов на старте, docs/37-accounting.md §3). */
const HOLD_ACCOUNT = "stars.bot.hold";
const AVAILABLE_ACCOUNT = "stars.bot.available";

export type PaymentProduct = "continue_run" | "shop_item" | "vip" | "donation";
export type PostingKind = "paid" | "release" | "refund";

/** Статья выручки — по виду покупки, а не по `sku`: донат не часть «Магазина» (docs/37 §3). Площадка пока одна — Telegram. */
const REVENUE_ACCOUNT: Readonly<Record<PaymentProduct, string>> = {
  shop_item: "revenue.shop.telegram",
  continue_run: "revenue.continue.telegram",
  vip: "revenue.vip.telegram",
  donation: "revenue.donation.telegram",
};

const PRODUCT_LABEL: Readonly<Record<PaymentProduct, string>> = {
  shop_item: "магазин",
  continue_run: "второй шанс",
  vip: "VIP",
  donation: "донат",
};

/** Покупка — то, что проводке нужно от строки `purchase` и аккаунта покупателя. */
export interface PostablePurchase {
  purchaseId: string;
  product: PaymentProduct;
  chargedStars: number;
  /** `test` — разработка, в учёт не идёт (Р14) */
  mode: "live" | "test";
  /** `null` — оплаты ещё не было */
  paidAt: Date | null;
  /** `null` — не возвращена */
  refundedAt: Date | null;
  /** площадка аккаунта покупателя: `telegram`, `max`, `vk`, `web` */
  platform: string;
}

/**
 * Что уже есть в журнале по этой покупке. `paid.releaseAt` — срок из проводки оплаты; `null` — проводка есть, а
 * срока в ней нет (записана не нашим кодом): тогда срок считается заново.
 */
export interface PostedState {
  paid: { releaseAt: Date | null } | null;
  release: boolean;
  refund: boolean;
}

export interface PostingPlanInput {
  purchase: PostablePurchase;
  /** срок холда по настройке сейчас; нужен только оплате, которой ещё нет в журнале */
  holdDays: number;
  now: Date;
  posted: PostedState;
}

export interface PlannedPosting {
  kind: PostingKind;
  entry: LedgerPostInput;
}

/** Покупка, которую провести нельзя; проход пишет предупреждение, а не падает. */
export type PostingWarning = "unsupported_platform" | "bad_amount";

export interface PostingPlan {
  postings: PlannedPosting[];
  warning: PostingWarning | null;
}

export function paymentSourceKey(purchaseId: string, kind: PostingKind): string {
  return `purchase:${purchaseId}:${kind}`;
}

/** Срок выхода из холда по настройке: оплата плюс `holdDays` суток. */
export function releaseAtFor(paidAt: Date, holdDays: number): Date {
  return new Date(paidAt.getTime() + holdDays * DAY_MS);
}

export function planPostings(input: PostingPlanInput): PostingPlan {
  const { purchase, holdDays, now, posted } = input;
  if (purchase.mode !== "live" || purchase.paidAt === null) return { postings: [], warning: null };
  // Статей других площадок в плане счетов пока нет: проводка выдуманным счётом была бы хуже отсутствующей.
  if (purchase.platform !== "telegram") return { postings: [], warning: "unsupported_platform" };
  // Нулевую строку журнал не примет; звёзд Telegram меньше одной не бывает, поэтому это ошибка данных.
  if (!Number.isSafeInteger(purchase.chargedStars) || purchase.chargedStars <= 0) return { postings: [], warning: "bad_amount" };

  const amount = BigInt(purchase.chargedStars);
  const revenue = REVENUE_ACCOUNT[purchase.product];
  // Срок записан в проводке оплаты и от настройки не зависит: смена `payments.hold-days.telegram` старые оплаты не двигает.
  const releaseAt = posted.paid?.releaseAt ?? releaseAtFor(purchase.paidAt, holdDays);
  const base = { purchaseId: purchase.purchaseId, product: purchase.product };

  const paidEntry: LedgerPostInput = {
    sourceKey: paymentSourceKey(purchase.purchaseId, "paid"),
    at: purchase.paidAt,
    memo: `Оплата звёздами, ${PRODUCT_LABEL[purchase.product]}: покупка ${purchase.purchaseId}`,
    lines: [
      { accountId: HOLD_ACCOUNT, amount },
      { accountId: revenue, amount: -amount },
    ],
    meta: { ...base, releaseAt: releaseAt.toISOString() },
  };

  const postings: PlannedPosting[] = [];
  if (posted.paid === null) postings.push({ kind: "paid", entry: paidEntry });

  // Возврат с датой в будущем (часы двух серверов разошлись) ждёт: иначе он обогнал бы выход из холда.
  const refundedAt = purchase.refundedAt !== null && purchase.refundedAt.getTime() <= now.getTime() ? purchase.refundedAt : null;
  const refundFromHold = refundedAt !== null && !posted.release && refundedAt.getTime() < releaseAt.getTime();

  if (!posted.release && releaseAt.getTime() <= now.getTime() && !refundFromHold) {
    postings.push({
      kind: "release",
      entry: {
        sourceKey: paymentSourceKey(purchase.purchaseId, "release"),
        at: releaseAt,
        memo: `Выход из холда: покупка ${purchase.purchaseId}`,
        lines: [
          { accountId: HOLD_ACCOUNT, amount: -amount },
          { accountId: AVAILABLE_ACCOUNT, amount },
        ],
        meta: base,
      },
    });
  }

  if (refundedAt !== null && !posted.refund) {
    const sourceKey = paymentSourceKey(purchase.purchaseId, "refund");
    postings.push({
      kind: "refund",
      entry: refundFromHold
        ? { ...reverse(paidEntry, sourceKey, refundedAt, `Возврат до выхода из холда, сторно оплаты: покупка ${purchase.purchaseId}`), meta: base }
        : {
            sourceKey,
            at: refundedAt,
            memo: `Возврат из доступных звёзд: покупка ${purchase.purchaseId}`,
            lines: [
              { accountId: AVAILABLE_ACCOUNT, amount: -amount },
              { accountId: revenue, amount },
            ],
            meta: base,
          },
    });
  }

  return { postings, warning: null };
}
