import { z } from "zod";
import type { Permission } from "../roles/permissions.js";
import type { AuditRecord } from "../roles/roles.repository.js";
import type { PurchaseAction, RefundReason, StoredPurchase } from "./purchase-types.js";

/**
 * Хронология платежа в карточке панели (Р209, WP53, tasks/T-0429): правила и
 * типы без Nest и Prisma. Строки приходят из трёх мест — из самой покупки и её
 * продлений (`purchaseTimeline`), из журнала действий команды (`teamTimeline`)
 * и из источников, которые подключают соседние задачи (`payment-feed-sources.ts`);
 * `mergeTimeline` складывает их по времени.
 */

/** Виды строк — в порядке жизни платежа: при равном времени строки идут именно так. */
export const TIMELINE_KINDS = [
  "invoice",
  "checkout",
  "paid",
  "renewal",
  "fulfilled",
  "refund_requested",
  "refunded",
  "compensated",
  "job_abandoned",
  "discrepancy",
  "team",
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export interface TimelineEntry {
  at: Date;
  kind: TimelineKind;
  /** строка для человека, по-русски, до 200 знаков */
  text: string;
  /** имя того, кто сделал; у системы и площадки — null */
  actorName: string | null;
}

/** Пометки строки ленты: у покупки есть компенсация, брошенное задание или расхождение со сверкой. */
export const FEED_MARKS = ["compensated", "job_abandoned", "discrepancy"] as const;
export type FeedMark = (typeof FEED_MARKS)[number];

/** Право на действие — проверяет сервис карточки, панель только прячет кнопки. */
export const ACTION_PERMISSION: Record<PurchaseAction, Permission> = {
  refund: "payments.support",
  fulfill: "payments.support",
  retry: "payments.support",
  compensate: "payments.compensate",
};

/** Сначала то, что не стоит денег. */
export const ACTION_ORDER: readonly PurchaseAction[] = ["fulfill", "retry", "refund", "compensate"];

const TEXT_MAX = 200;

/** Подписи причин возврата — те же, что в панели (`apps/admin/src/api/players.ts`). */
const REFUND_LABELS: Readonly<Record<RefundReason, string>> = {
  test_mode: "тестовая оплата",
  unused: "второй шанс не использован",
  external: "вернули вне игры",
  undeliverable: "товара нет в каталоге",
  manual: "вручную, поддержка",
};

/** Подписи действий команды из журнала; незнакомое `payments.*` показывается своим именем. */
const TEAM_TEXTS: ReadonlyMap<string, string> = new Map([
  ["payments.refund", "Возврат звёзд вручную"],
  ["payments.fulfill", "Повторная выдача"],
  ["payments.retry", "Повтор учёта"],
  ["payments.compensate", "Компенсация"],
  ["payments.discrepancy.retry", "Повтор учёта по сверке"],
  ["payments.discrepancy.refund", "Возврат звёзд по сверке"],
  ["payments.discrepancy.dismiss", "Расхождение разобрано"],
  ["payments.job.retry", "Повтор брошенного задания"],
]);

const TEAM_PREFIX = "payments.";

/**
 * Что журнал хранит в `after` у действий с покупкой. Лишние поля допустимы —
 * у каждого действия свои. Примечание не строкой — не повод прятать действие
 * команды: оно остаётся в хронологии без примечания.
 */
const auditAfterSchema = z.looseObject({ purchaseId: z.string(), note: z.string().optional().catch(undefined) });

const KIND_RANK: ReadonlyMap<TimelineKind, number> = new Map(TIMELINE_KINDS.map((kind, index) => [kind, index]));

/** По времени, при равном времени — в порядке видов; остальное решает порядок поступления (сортировка устойчива). */
function byMoment(a: TimelineEntry, b: TimelineEntry): number {
  return a.at.getTime() - b.at.getTime() || (KIND_RANK.get(a.kind) ?? 0) - (KIND_RANK.get(b.kind) ?? 0);
}

function entry(at: Date, kind: TimelineKind, text: string, actorName: string | null = null): TimelineEntry {
  return { at, kind, text: cut(text), actorName };
}

/** Не длиннее 200 знаков: срез по знакам, а не по кодовым единицам — пара суррогатов не рвётся. */
function cut(text: string): string {
  const chars = [...text];
  return chars.length <= TEXT_MAX ? text : `${chars.slice(0, TEXT_MAX - 1).join("")}…`;
}

function reasonLabel(reason: RefundReason | null): string {
  return reason === null ? "—" : REFUND_LABELS[reason];
}

/**
 * Строки хронологии из самой покупки и её продлений. Счёт — на сумму, которую
 * площадка и списала (`chargedStars`: в тестовом режиме это одна звезда, а не
 * показанная цена).
 */
export function purchaseTimeline(purchase: StoredPurchase, renewals: readonly StoredPurchase[]): TimelineEntry[] {
  const lines = [entry(purchase.invoicedAt, "invoice", `Счёт выставлен: ${String(purchase.chargedStars)} ⭐`)];
  if (purchase.paidAt !== null) lines.push(entry(purchase.paidAt, "paid", `Оплата записана: списано ${String(purchase.chargedStars)} ⭐`));
  for (const renewal of renewals) {
    if (renewal.paidAt !== null) lines.push(entry(renewal.paidAt, "renewal", `Продление оплачено: ${String(renewal.chargedStars)} ⭐`));
  }
  if (purchase.fulfilledAt !== null) lines.push(entry(purchase.fulfilledAt, "fulfilled", "Товар выдан"));
  if (purchase.refundRequestedAt !== null) lines.push(entry(purchase.refundRequestedAt, "refund_requested", `Возврат заказан: ${reasonLabel(purchase.refundReason)}`));
  if (purchase.refundedAt !== null) lines.push(entry(purchase.refundedAt, "refunded", `Звёзды возвращены: ${reasonLabel(purchase.refundReason)}`));
  return lines.sort(byMoment);
}

/**
 * Строки журнала действий по этой покупке: `after.purchaseId` равен её id;
 * остальные записи — чужие покупки, чужие действия и записи с непонятным
 * `after` — отбрасываются. Имя актёра — из карты; нет в карте — его id.
 */
export function teamTimeline(purchaseId: string, records: readonly AuditRecord[], names: ReadonlyMap<string, string>): TimelineEntry[] {
  const lines: TimelineEntry[] = [];
  for (const record of records) {
    if (!record.action.startsWith(TEAM_PREFIX)) continue;
    const after = auditAfterSchema.safeParse(record.after);
    if (!after.success || after.data.purchaseId !== purchaseId) continue;
    const label = TEAM_TEXTS.get(record.action) ?? record.action;
    const note = after.data.note?.trim() ?? "";
    const actorName = record.actorAccountId === null ? null : (names.get(record.actorAccountId) ?? record.actorAccountId);
    lines.push(entry(record.createdAt, "team", note === "" ? label : `${label} — ${note}`, actorName));
  }
  return lines.sort(byMoment);
}

/** Всё вместе: по времени, при равном времени — в порядке `TIMELINE_KINDS`. Входные массивы не меняются. */
export function mergeTimeline(parts: readonly (readonly TimelineEntry[])[]): TimelineEntry[] {
  return parts.flat().sort(byMoment);
}
