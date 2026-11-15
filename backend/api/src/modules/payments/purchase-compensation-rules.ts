import { pluralRu } from "../../common/card/labels.js";
import { skuById } from "../shop/shop-catalog.js";
import type { WalletEntryRow } from "../wallet/wallet.repository.js";
import { ADMIN_REASON, type ExchangeReason, type WalletResource } from "../wallet/wallet-types.js";
import { starsToGems } from "./continue-price.js";
import type { TimelineEntry } from "./payment-timeline.js";
import type { CompensationRow } from "./purchase-compensation.repository.js";
import type { StoredPurchase } from "./purchase-types.js";

/**
 * Правила компенсации за сбой оплаты (docs/35-stage4-plan.md, Р209, WP53,
 * tasks/T-0435): чистые функции без Nest и Prisma — предложение суммы, когда
 * компенсировать нельзя и текст строки хронологии. Сервис
 * (`purchase-compensation.ts`) только раскладывает их по хранилищам.
 */

/** Только самоцветы (Р2): ресурс один, и кошелёк другого за эту причину не начислит. */
export const COMPENSATION_RESOURCE = "gems" satisfies WalletResource;

/** Причина записи в журнале кошелька: без суточного потолка и без надбавки VIP — они у причин заработка. */
export const COMPENSATION_REASON = "payment_compensation" satisfies ExchangeReason;

/** За сколько суток предложение показывает начисления через «Кошелёк ±»: компенсировать вручную могли и раньше. */
export const MANUAL_LOOKBACK_DAYS = 30;

const DAY_MS = 86_400_000;

/** Тексты отказов — дословно из решений Р209; панель показывает их как есть. */
export const COMPENSATION_TEXTS = {
  unpaid: "Оплата не записана — сначала «Повторить учёт»",
  donation: "Донат не компенсируется: у него нет игровой ценности. Повторите учёт — знак мецената встанет сам",
  test: "Тестовая оплата — компенсировать нечего",
  own: "Компенсировать свою покупку нельзя",
  credited: "За эту покупку компенсация уже начислена",
} as const;

/** Не длиннее строки хронологии платежа (`payment-timeline.ts`, `TEXT_MAX`). */
const TIMELINE_TEXT_MAX = 200;

/**
 * Эквивалент покупки в самоцветах. Набор магазина — его состав: игрок купил
 * именно столько самоцветов; товара уже нет в каталоге, а также второй шанс и
 * VIP — уплаченные звёзды по курсу второго шанса. У доната игровой ценности
 * нет, эквивалента тоже.
 */
export function equivalentGems(purchase: Pick<StoredPurchase, "product" | "sku" | "chargedStars">): number | null {
  if (purchase.product === "donation") return null;
  if (purchase.product === "shop_item" && purchase.sku !== null) {
    const gems = skuById(purchase.sku)?.contents.gems;
    if (gems !== undefined) return gems;
  }
  return starsToGems(purchase.chargedStars);
}

/** Что предлагает панель: эквивалент на множитель, не больше потолка; эквивалента нет — предложения нет. */
export function suggestedGems(equivalent: number | null, multiplier: number, maxGems: number): number | null {
  return equivalent === null ? null : Math.min(equivalent * multiplier, maxGems);
}

/**
 * Почему компенсировать нельзя — текст из `COMPENSATION_TEXTS`; `null` — можно.
 * Порядок проверок — как в решениях: оплата, донат, тестовая оплата, своя
 * покупка, уже начислена. Возвращённая покупка компенсируется: возврат правилом
 * не закрыт. Тестовая оплата и своя покупка допустимы на машине разработчика —
 * владелец и игрок там один человек, и проверить на себе иначе нельзя.
 * `actorAccountId: null` — проверка своей покупки пропускается: источник ленты
 * зовёт без актёра, сервис — с ним.
 */
export function compensationBlock(
  purchase: Pick<StoredPurchase, "paidAt" | "product" | "mode" | "accountId">,
  context: { devLogin: boolean; actorAccountId: string | null; credited: boolean },
): string | null {
  if (purchase.paidAt === null) return COMPENSATION_TEXTS.unpaid;
  if (purchase.product === "donation") return COMPENSATION_TEXTS.donation;
  if (purchase.mode === "test" && !context.devLogin) return COMPENSATION_TEXTS.test;
  if (context.actorAccountId !== null && context.actorAccountId === purchase.accountId && !context.devLogin) return COMPENSATION_TEXTS.own;
  if (context.credited) return COMPENSATION_TEXTS.credited;
  return null;
}

/** Ключ журнала кошелька: одна компенсация на покупку, повтор действия второй раз не начислит. */
export function compensationKey(purchaseId: string): string {
  return `compensation:${purchaseId}`;
}

/** Текст отказа «Больше потолка» — с ключом, где потолок меняют. */
export function overCeilingText(maxGems: number): string {
  return `Больше потолка: ${String(maxGems)} ${gemsWord(maxGems)} — его меняют в «Настройках», ключ «Потолок компенсации»`;
}

export interface ManualGrant {
  at: Date;
  resource: WalletResource;
  amount: number;
}

/**
 * Начисления игроку через «Кошелёк ±» за последние `MANUAL_LOOKBACK_DAYS`
 * суток — только в плюс: владелец мог компенсировать вручную до этой задачи, и
 * окно не должно предлагать вторую выплату вслепую. Порядок записей — как у
 * журнала, новые первыми.
 */
export function recentManualGrants(entries: readonly Pick<WalletEntryRow, "reason" | "amount" | "resource" | "createdAt">[], now: Date): ManualGrant[] {
  const since = now.getTime() - MANUAL_LOOKBACK_DAYS * DAY_MS;
  return entries
    .filter((entry) => entry.reason === ADMIN_REASON && entry.amount > 0 && entry.createdAt.getTime() >= since)
    .map((entry) => ({ at: entry.createdAt, resource: entry.resource, amount: entry.amount }));
}

/**
 * Строка хронологии платежа по компенсации: начисленная — во время
 * начисления, записанная без начисления — во время записи и с подсказкой, что
 * делать. Текст не длиннее двухсот знаков, как у остальных строк.
 */
export function compensationTimeline(row: Pick<CompensationRow, "amount" | "note" | "createdAt" | "creditedAt">, actorName: string | null): TimelineEntry {
  if (row.creditedAt === null) {
    return { at: row.createdAt, kind: "compensated", text: "Компенсация записана, но не начислена — нажмите «Компенсировать» ещё раз", actorName };
  }
  return { at: row.creditedAt, kind: "compensated", text: cut(`Компенсация: ${String(row.amount)} ${gemsWord(row.amount)} — ${row.note}`), actorName };
}

function gemsWord(count: number): string {
  return pluralRu(count, "самоцвет", "самоцвета", "самоцветов");
}

/** Срез по знакам, а не по кодовым единицам: пара суррогатов не рвётся. */
function cut(text: string): string {
  const chars = [...text];
  return chars.length <= TIMELINE_TEXT_MAX ? text : `${chars.slice(0, TIMELINE_TEXT_MAX - 1).join("")}…`;
}
