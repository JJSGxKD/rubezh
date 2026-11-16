import type { ParticipantStatus, PayoutBody, PayoutStatusView, PeriodReportView, PeriodStatus, ReportView } from "../../../api/ledger-periods";
import { CURRENCY_DECIMALS, toMinor } from "../operations/money";

/**
 * Чистые правила вкладки «Месяцы» (tasks/T-0470, Р222): подписи, формат сумм из строк сервера, какие кнопки видны,
 * цели выплат и проверка формы выплаты. Деньги панель не считает: суммы приходят строками сервера, а здесь их только
 * форматируют (и единственный итог — «участникам на всех» в окне закрытия — складывается из строк отчёта целыми копейками).
 */

const DAY_MS = 86_400_000;
const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"] as const;

/** «2026-11» → «Ноябрь». */
export function monthName(period: string): string {
  const month = Number(period.slice(5, 7));
  return MONTHS[month - 1] ?? period;
}

/** «2026-11» → «Ноябрь 2026». */
export function monthTitle(period: string): string {
  return `${monthName(period)} ${period.slice(0, 4)}`;
}

/** Тысячи пробелом: «1234567» → «1 234 567». */
function grouped(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/gu, " ");
}

/** Десятичная строка сервера → знак, целая часть и дробь без изменений. */
function split(value: string): { sign: string; integer: string; fraction: string } {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value.trim());
  if (match === null) return { sign: "", integer: value, fraction: "" };
  return { sign: match[1] ?? "", integer: match[2] ?? "", fraction: match[3] ?? "" };
}

/** «10925.60» → «10 925,60 ₽»; «2944.00» → «2 944 ₽»: копейки только если они есть. */
export function formatRub(value: string): string {
  const { sign, integer, fraction } = split(value);
  const kopecks = /^0*$/u.test(fraction) ? "" : `,${fraction}`;
  return `${sign}${grouped(integer)}${kopecks} ₽`;
}

/** «246.54» → «$246.54»: доллары с центами, как отдаёт сервер. */
export function formatUsd(value: string): string {
  const { sign, integer, fraction } = split(value);
  return `${sign}$${grouped(integer)}${fraction === "" ? "" : `.${fraction}`}`;
}

/** Копейки из рублёвой строки сервера: «10925.60» → 1 092 560. */
function kopecksOf(value: string): bigint {
  const { sign, integer, fraction } = split(value);
  const total = BigInt(integer + fraction.padEnd(2, "0").slice(0, 2));
  return sign === "-" ? -total : total;
}

function rubOf(kopecks: bigint): string {
  const digits = kopecks.toString().padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** Сумма рублёвых долей участников из строк отчёта — для строки последствий закрытия. */
export function participantsTotalRub(report: ReportView): string {
  return rubOf(report.payouts.reduce((sum, payout) => sum + kopecksOf(payout.rub), 0n));
}

/** Что произойдёт при закрытии: цифры из отчёта, который сервер посчитал, и напоминание про сообщение. */
export function closeConsequence(period: string, report: ReportView): string {
  const share = report.noDistribution || report.payouts.length === 0 ? "делить нечего" : `участникам — ${formatRub(participantsTotalRub(report))} на всех`;
  return `${monthName(period)} закроется: налог ${formatRub(report.tax.rub)}, ${share}. Участникам придёт сообщение.`;
}

export interface CloseControl {
  visible: boolean;
  disabled: boolean;
  blockedBy: string | null;
}

/** «Закрыть месяц»: есть у владельца на месяце «на сверке»; неактивна, пока есть блокеры или отчёт не посчитан. */
export function closeControl(args: { view: PeriodReportView; allowed: boolean }): CloseControl {
  const { view, allowed } = args;
  if (!allowed || view.status !== "review") return { visible: false, disabled: true, blockedBy: null };
  const blockers = view.checklist.filter((item) => item.severity === "blocker").length;
  if (blockers > 0) return { visible: true, disabled: true, blockedBy: `Есть блокеры: ${String(blockers)}` };
  if (view.report === null) return { visible: true, disabled: true, blockedBy: "Отчёт не посчитан: нет курса на дату проводки" };
  if (!view.canClose) return { visible: true, disabled: true, blockedBy: "Сервер пока не разрешает закрыть месяц" };
  return { visible: true, disabled: false, blockedBy: null };
}

/** «Начать сверку»: открытый месяц, который уже кончился (UTC), и право закрывать месяцы. */
export function reviewControl(args: { period: string; status: PeriodStatus; now: Date; allowed: boolean }): boolean {
  return args.allowed && args.status === "open" && args.period < args.now.toISOString().slice(0, 7);
}

/** «Снять закрытие»: закрытый месяц, по которому ещё никому не выплачено. */
export function reopenControl(args: { status: PeriodStatus; payoutsCount: number; allowed: boolean }): boolean {
  return args.allowed && args.status === "closed" && args.payoutsCount === 0;
}

/** Решение участника по отчёту: «подтвердил», «оспорил (комментарий)» или «молчит N дн.» со дня закрытия. */
export function confirmationLabel(participant: Pick<ParticipantStatus, "confirmation">, closedAt: Date, now: Date): string {
  const { confirmation } = participant;
  if (confirmation?.status === "confirmed") return "подтвердил";
  if (confirmation?.status === "disputed") return confirmation.comment === null ? "оспорил" : `оспорил (${confirmation.comment})`;
  const days = Math.max(0, Math.floor((now.getTime() - closedAt.getTime()) / DAY_MS));
  return `молчит ${String(days)} дн.`;
}

const isZero = (value: string): boolean => /^0*(\.0*)?$/u.test(value.trim());

/** Кому и на что можно оформить выплату. `currency: null` — в любой валюте места (владельцу). */
export interface PayoutTarget {
  payee: string;
  label: string;
  /** подпись кнопки */
  action: string;
  currency: string | null;
  /** сумма по умолчанию — остаток долга из ответа сервера; у владельца пусто: он решает сам */
  amount: string;
  needsReason: boolean;
  /** почему нужна причина — текст сервера */
  reasonHint: string | null;
  note: (period: string) => string;
}

/**
 * Получатели, которым сейчас можно платить: участники, которых сервер разрешил (`canPay`), налог и займы с остатком,
 * владелец, если в отчёте есть его доля. Остальное — ждёт подтверждения или выплачено.
 */
export function payoutTargets(status: PayoutStatusView): PayoutTarget[] {
  const targets: PayoutTarget[] = [];
  for (const participant of status.participants) {
    if (!participant.canPay) continue;
    targets.push({
      payee: `stakeholder:${participant.accountId}`,
      label: participant.name,
      action: "Выплатить",
      currency: "RUB",
      amount: participant.remainingRub,
      needsReason: participant.needsReason,
      reasonHint: participant.needsReason ? participant.reason : null,
      note: (period) => `Выплата за ${monthName(period).toLowerCase()}: ${participant.name}`,
    });
  }
  if (status.tax !== null && !isZero(status.tax.remainingRub)) {
    targets.push({ payee: "tax", label: "Налог НПД", action: "Заплатить налог", currency: "RUB", amount: status.tax.remainingRub, needsReason: false, reasonHint: null, note: (period) => `Налог НПД за ${monthName(period).toLowerCase()}` });
  }
  for (const loan of status.loans) {
    if (isZero(loan.remaining)) continue;
    targets.push({
      payee: `loan:${loan.loanId}`,
      label: `Заём: ${loan.lender}`,
      action: "Погасить транш",
      currency: loan.currency,
      amount: loan.remaining,
      needsReason: false,
      reasonHint: null,
      note: (period) => `Транш займа за ${monthName(period).toLowerCase()}: ${loan.lender}`,
    });
  }
  if (status.owner !== null) {
    targets.push({ payee: "owner", label: "Владелец", action: "Выплатить себе", currency: null, amount: "", needsReason: false, reasonHint: null, note: (period) => `Выплата владельцу за ${monthName(period).toLowerCase()}` });
  }
  return targets;
}

export interface PayoutForm {
  payee: string;
  from: string;
  amount: string;
  reason: string;
  note: string;
  at: string;
}

export interface PlaceOption {
  accountId: string;
  name: string;
  currency: string;
}

/** Пределы текста сервера: описание и причина — от 3 до 500 знаков. */
export const TEXT_MIN = 3;
export const TEXT_MAX = 500;

const currencyWord = (currency: string): string => (currency === "RUB" ? "в рублях" : `в валюте ${currency}`);

/** Первая проблема формы выплаты — текстом под полями; `null` — можно отправлять. Остатки и сроки проверяет сервер. */
export function payoutProblem(form: PayoutForm, target: PayoutTarget, places: readonly PlaceOption[]): string | null {
  const place = places.find((item) => item.accountId === form.from);
  if (form.from === "" || place === undefined) return "Выберите место, с которого платите";
  if (target.currency !== null && place.currency !== target.currency) return `Платить нужно ${currencyWord(target.currency)}: у места «${place.name}» валюта ${place.currency}`;

  const amount = form.amount.trim().replace(",", ".");
  if (amount === "") return "Укажите сумму";
  const decimals = CURRENCY_DECIMALS[place.currency];
  const fraction = /^\d+\.(\d+)$/u.exec(amount)?.[1];
  if (decimals !== undefined && fraction !== undefined && fraction.length > decimals) return `Слишком много знаков: у валюты ${place.currency} их ${String(decimals)}`;
  const minor = toMinor(amount, place.currency);
  if (minor === null) return "Сумма — число вида 1500.00, без знака и букв";
  if (minor === 0n) return "Сумма должна быть больше нуля";

  const note = form.note.trim();
  if (note.length < TEXT_MIN || note.length > TEXT_MAX) return `Описание — от ${String(TEXT_MIN)} до ${String(TEXT_MAX)} знаков`;
  if (target.needsReason) {
    const reason = form.reason.trim();
    if (reason.length < TEXT_MIN || reason.length > TEXT_MAX) return `Нужна причина вашего решения — от ${String(TEXT_MIN)} до ${String(TEXT_MAX)} знаков`;
  }
  return null;
}

/** Тело запроса операции «Выплата»; причина уходит, только если она введена. */
export function payoutBody(period: string, form: PayoutForm): PayoutBody {
  const reason = form.reason.trim();
  return {
    kind: "payout",
    payee: form.payee,
    period,
    from: form.from,
    amount: form.amount.trim().replace(",", "."),
    note: form.note.trim(),
    at: form.at,
    ...(reason === "" ? {} : { overrideReason: reason }),
  };
}
