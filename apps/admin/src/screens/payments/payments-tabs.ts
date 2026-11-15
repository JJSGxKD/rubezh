import { PLATFORMS, titleOf, type DiscrepancyActionId, type DiscrepancyKind, type ReconcileRun } from "../../api/payments";
import { purchaseNoteProblem, resourceName } from "../../api/players";
import { formatDateTime, formatNumber, plural } from "../../format";
import { isPurchaseId } from "./feed-filters";

/**
 * Вкладки раздела «Платежи» (tasks/T-0438, Р209, WP53) и чистые правила их
 * экранов: подписи видов расхождений и кнопки по ним, проверка окна
 * компенсации, строка последней сверки. Кнопки сервер проверит сам (T-0434) —
 * здесь только то, что показать.
 */

export const PAYMENTS_TABS = [
  { id: "feed", title: "Лента" },
  { id: "discrepancies", title: "Расхождения" },
  { id: "jobs", title: "Брошенные задания" },
] as const;

export type PaymentsTab = (typeof PAYMENTS_TABS)[number]["id"];

/**
 * Вкладка из второй части адреса. Номер покупки — карточка, у неё вкладок нет
 * (`null`); пусто и незнакомое слово — лента.
 */
export function tabOfRoute(id: string | null): PaymentsTab | null {
  const named = PAYMENTS_TABS.find((tab) => tab.id === id);
  if (named !== undefined) return named.id;
  return isPurchaseId(id) ? null : "feed";
}

/** Адрес вкладки: лента — без хвоста. */
export function tabId(tab: PaymentsTab): string | null {
  return tab === "feed" ? null : tab;
}

/** Подпись вида расхождения; у возврата — с названием площадки. */
export function discrepancyLabel(kind: DiscrepancyKind, platform: string): string {
  if (kind === "charged_unrecorded") return "Списано, но не записано";
  if (kind === "recorded_missing") return "Записано, но нет в выписке";
  return `Возврат в ${titleOf(PLATFORMS, platform)}, но не у нас`;
}

/** Какие действия предлагает панель по виду расхождения, по порядку кнопок. */
export function discrepancyButtons(kind: DiscrepancyKind): readonly DiscrepancyActionId[] {
  if (kind === "charged_unrecorded") return ["retry", "refund", "dismiss"];
  if (kind === "refund_unrecorded") return ["retry", "dismiss"];
  return ["dismiss"];
}

const RESOLUTIONS: Readonly<Record<string, string>> = {
  matched: "сошлось само",
  retried: "учёт повторён",
  refunded: "звёзды возвращены",
  dismissed: "разобрано",
};

export function resolutionLabel(resolution: string): string {
  return RESOLUTIONS[resolution] ?? resolution;
}

const JOB_KINDS: Readonly<Record<string, string>> = {
  confirm: "подтверждение оплаты",
  refund: "возврат",
  refunded: "внешний возврат",
  unknown: "неизвестно",
};

export function jobKindLabel(kind: string): string {
  return JOB_KINDS[kind] ?? kind;
}

const GEMS = ["самоцвет", "самоцвета", "самоцветов"] as const;

/** После «до»: родительный падеж, «до 1 самоцвета», «до 5 самоцветов». */
const GEMS_UP_TO = ["самоцвета", "самоцветов", "самоцветов"] as const;

/** Склонение самоцветов: «1 самоцвет», «300 самоцветов» — без числа, только слово. */
export function gemsWord(count: number): string {
  return plural(count, GEMS);
}

/** Что не так с суммой компенсации; `null` — сумма годится. */
export function gemsProblem(gems: number, maxGems: number): string | null {
  if (!Number.isInteger(gems) || gems < 1 || gems > maxGems) return `Сумма — целое число от 1 до ${String(maxGems)} ${plural(maxGems, GEMS_UP_TO)}`;
  return null;
}

/** Что не так в окне компенсации; `null` — можно начислять. */
export function compensationProblem(gems: number, maxGems: number, note: string): string | null {
  return gemsProblem(gems, maxGems) ?? purchaseNoteProblem(note);
}

/** Ручные начисления игроку одной строкой для предупреждения: «100 самоцветов 11.11, 50 монеты 09.11». */
export function manualGrantsLine(grants: readonly { at: string; resource: string; amount: number }[]): string {
  return grants
    .map((grant) => {
      const date = new Date(grant.at);
      const day = Number.isNaN(date.getTime()) ? "—" : `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}`;
      const what = grant.resource === "gems" ? plural(grant.amount, GEMS) : resourceName(grant.resource).toLowerCase();
      return `${formatNumber(grant.amount)} ${what} ${day}`;
    })
    .join(", ");
}

/** Строка о последней сверке площадки; `null` — сверок не было. */
export function lastRunLine(run: Pick<ReconcileRun, "startedAt" | "finishedAt" | "scanned" | "found" | "error"> | null): string {
  if (run === null) return "Сверок ещё не было";
  const when = formatDateTime(run.finishedAt ?? run.startedAt);
  if (run.error !== null) return `Последняя сверка оборвалась ${when}: ${run.error}`;
  return `Последняя сверка: ${when} · прочитано ${String(run.scanned)} ${plural(run.scanned, ["операцию", "операции", "операций"])} · новых расхождений ${String(run.found)}`;
}
