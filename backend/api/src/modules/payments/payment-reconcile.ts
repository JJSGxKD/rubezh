import type { StatementEntry } from "../../platforms/ports/payment-statement.js";

/**
 * Правила сверки оплат с выпиской площадки (docs/35-stage4-plan.md, Р209,
 * WP53, tasks/T-0433): что считается расхождением, с какого места читать
 * выписку, когда пора сверять и что закрывается само. Чистые функции — без
 * Nest, Prisma и площадки: чтение выписки и запись расхождений — в
 * `payment-reconciler.ts`.
 *
 * Выписка — то, что площадка на самом деле списала и вернула; покупки — то,
 * что записали мы. Расхождение — места, где они не сходятся: деньги списаны
 * и не записаны (11.11.2026 так и было), записаны и не списаны, возвращены
 * на площадке и не у нас.
 */

export const DISCREPANCY_KINDS = ["charged_unrecorded", "recorded_missing", "refund_unrecorded"] as const;
export type DiscrepancyKind = (typeof DISCREPANCY_KINDS)[number];

/** Чем закрыто расхождение: само (`matched`), повтором учёта, возвратом звёзд или «Разобрано» — решает T-0434. */
export const DISCREPANCY_RESOLUTIONS = ["matched", "retried", "refunded", "dismissed"] as const;
export type DiscrepancyResolution = (typeof DISCREPANCY_RESOLUTIONS)[number];

/** Кто запустил сверку: расписание или кнопка в панели. */
export const RECONCILE_TRIGGERS = ["schedule", "manual"] as const;
export type ReconcileTrigger = (typeof RECONCILE_TRIGGERS)[number];

/**
 * Числа сверки (docs/30-configuration-map.md). Перекрытие — запас на границе
 * курсора; окно свежести — сколько очереди оплаты даём записать оплату или
 * возврат, прежде чем считать их потерянными; запас края — оплата у границы
 * прочитанного отрезка могла быть совершена чуть раньше первой операции.
 */
export const RECONCILE = {
  pageSize: 100,
  maxPages: 100,
  overlap: 100,
  graceMs: 15 * 60_000,
  edgeMs: 30 * 60_000,
  minIntervalMs: 23 * 3_600_000,
  tickMs: 3_600_000,
  firstTickMs: 5 * 60_000,
  lockTtlMs: 15 * 60_000,
  pageTimeoutMs: 20_000,
} as const;

/** Длина `payload` расхождения в базе: счёт приходит от площадки и может быть длиннее. */
const PAYLOAD_MAX = 128;

/** Наша покупка, у которой есть идентификатор оплаты. */
export interface KnownPurchase {
  purchaseId: string;
  accountId: string;
  chargeId: string;
  chargedStars: number;
  paidAt: Date;
  refundedAt: Date | null;
}

export interface FoundDiscrepancy {
  kind: DiscrepancyKind;
  chargeId: string;
  purchaseId: string | null;
  accountId: string | null;
  payerId: string | null;
  amount: number;
  payload: string | null;
  occurredAt: Date;
}

export interface CompareInput {
  /** прочитанная выписка, от старых к новым */
  entries: readonly StatementEntry[];
  /** наши покупки с оплатами из выписки — по идентификатору оплаты */
  byCharge: ReadonlyMap<string, KnownPurchase>;
  /** покупки по `payload` оплат, которых нет в `byCharge`, — чтобы назвать игрока */
  byPayload: ReadonlyMap<string, { purchaseId: string; accountId: string }>;
  /** наши оплаты площадки с `paid_at` внутри [первая операция + edgeMs, последняя операция] */
  paidInWindow: readonly KnownPurchase[];
  now: Date;
}

/**
 * Расхождения выписки и покупок по трём правилам (Р209). Оплата или возврат
 * моложе `graceMs` не сверяются: очередь оплаты могла ещё не записать их.
 * Повтор одного идентификатора в выписке — одна находка. Возврат по оплате,
 * которой у нас нет, — не расхождение: лишнюю или чужую оплату мы возвращаем
 * сами, а её самой видно по «списано, но не записано».
 */
export function compare(input: CompareInput): FoundDiscrepancy[] {
  const { entries, byCharge, byPayload, paidInWindow, now } = input;
  const found: FoundDiscrepancy[] = [];
  const taken = new Set<string>();
  const add = (item: FoundDiscrepancy): void => {
    const key = `${item.kind}\u0000${item.chargeId}`;
    if (taken.has(key)) return;
    taken.add(key);
    found.push(item);
  };

  // Оплаты выписки собираются до проверки свежести: свежая оплата в выписке — тоже «оплата есть».
  const statementPayments = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "payment") statementPayments.add(entry.id);
    if (entry.kind === "other") continue;
    if (now.getTime() - entry.at.getTime() < RECONCILE.graceMs) continue;

    if (entry.kind === "payment") {
      if (byCharge.has(entry.id)) continue;
      const named = entry.payload === null ? undefined : byPayload.get(entry.payload);
      add({
        kind: "charged_unrecorded",
        chargeId: entry.id,
        purchaseId: named?.purchaseId ?? null,
        accountId: named?.accountId ?? null,
        payerId: entry.payerId,
        amount: entry.amount,
        payload: clipPayload(entry.payload),
        occurredAt: entry.at,
      });
      continue;
    }

    const own = byCharge.get(entry.id);
    if (own === undefined || own.refundedAt !== null) continue;
    add({
      kind: "refund_unrecorded",
      chargeId: entry.id,
      purchaseId: own.purchaseId,
      accountId: own.accountId,
      payerId: entry.payerId,
      amount: entry.amount,
      payload: clipPayload(entry.payload),
      occurredAt: entry.at,
    });
  }

  const window = windowOf(entries);
  if (window === null) return found;
  for (const purchase of paidInWindow) {
    if (purchase.paidAt < window.from || purchase.paidAt > window.to) continue;
    if (statementPayments.has(purchase.chargeId)) continue;
    add({
      kind: "recorded_missing",
      chargeId: purchase.chargeId,
      purchaseId: purchase.purchaseId,
      accountId: purchase.accountId,
      payerId: null,
      amount: purchase.chargedStars,
      payload: null,
      occurredAt: purchase.paidAt,
    });
  }
  return found;
}

/**
 * Отрезок, внутри которого ищутся «записано, но нет»: от первой прочитанной
 * операции плюс запас края до последней. Пустая выписка и выписка короче
 * запаса — `null`: покупка у границы могла быть оплачена до первой
 * прочитанной операции, и сверять её не с чем.
 */
export function windowOf(entries: readonly StatementEntry[]): { from: Date; to: Date } | null {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const at = entry.at.getTime();
    if (at < first) first = at;
    if (at > last) last = at;
  }
  if (entries.length === 0) return null;
  const from = first + RECONCILE.edgeMs;
  if (from > last) return null;
  return { from: new Date(from), to: new Date(last) };
}

/** С какой позиции читать: прошлой удачной сверки нет — с нуля; иначе её курсор минус перекрытие, не меньше нуля. */
export function startOffset(lastToOffset: number | null): number {
  return lastToOffset === null ? 0 : Math.max(0, lastToOffset - RECONCILE.overlap);
}

/** Пора ли сверять по расписанию: последняя удачная была больше 23 часов назад или её не было. */
export function due(lastFinishedAt: Date | null, now: Date): boolean {
  return lastFinishedAt === null || now.getTime() - lastFinishedAt.getTime() > RECONCILE.minIntervalMs;
}

/**
 * Какие открытые расхождения закрылись сами: «списано, но не записано» — id
 * оплаты теперь у покупки; «возврат не у нас» — у покупки отмечен возврат;
 * «записано, но нет в выписке» — оплата нашлась среди оплат прочитанной
 * выписки. Ответ — их идентификаторы. Чужое условие вид не закрывает.
 */
export function settled(
  open: readonly { discrepancyId: string; kind: DiscrepancyKind; chargeId: string }[],
  seen: { recordedCharges: ReadonlySet<string>; refundedCharges: ReadonlySet<string>; statementPayments: ReadonlySet<string> },
): string[] {
  return open
    .filter((row) => {
      switch (row.kind) {
        case "charged_unrecorded":
          return seen.recordedCharges.has(row.chargeId);
        case "refund_unrecorded":
          return seen.refundedCharges.has(row.chargeId);
        case "recorded_missing":
          return seen.statementPayments.has(row.chargeId);
      }
    })
    .map((row) => row.discrepancyId);
}

/**
 * Счёт из выписки — до 128 знаков, по кодовым точкам: срез по кодовым единицам
 * разорвал бы суррогатную пару, а ноль-символ Postgres в тексте не принимает.
 */
function clipPayload(payload: string | null): string | null {
  if (payload === null) return null;
  return [...payload.replaceAll("\u0000", "")].slice(0, PAYLOAD_MAX).join("");
}
