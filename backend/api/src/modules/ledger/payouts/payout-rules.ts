import { formatMinor } from "@bh/ledger";
import { currencySpec } from "../ledger-currencies.js";
import type { PeriodStatus } from "../periods/period-rules.js";
import type { Payee } from "./payee.js";
import type { StoredConfirmation } from "./payout-types.js";

/**
 * Правила «можно ли платить» (docs/37-accounting.md §13, Р222, tasks/T-0469): чистые функции без Nest и Prisma. Данные
 * месяца — что он должен получателю, что уже выплачено, что решил участник — приходят готовыми (`PayoutFacts`), поэтому
 * одно и то же правило решает и при сборке проводки, и в статусе месяца для владельца: статус не может обещать выплату,
 * которую сборщик потом откажет.
 */

export const DAY_MS = 86_400_000;

/** Что известно о месяце и получателе в момент выплаты. */
export interface PayoutFacts {
  /** «сейчас» для срока подтверждения: читается один раз при загрузке фактов */
  now: Date;
  /** срок молчания участника, суток (`finance.confirm-days`) */
  confirmDays: number;
  periodStatus: PeriodStatus;
  /** когда месяц закрыт последний раз; у незакрытого — `null` */
  closedAt: Date | null;
  /** получатель есть в отчёте месяца: у участника долг, у налога сумма, у займа транш, у владельца что делить */
  inReport: boolean;
  /** что месяц должен получателю, в минимальных единицах его валюты; `null` — у владельца суммы долга нет, предела нет */
  owed: bigint | null;
  /** в какой валюте платится; `null` — владельцу можно в любой */
  currency: string | null;
  /** счёт обязательства получателя; `null` у владельца: его счёт зависит от валюты места */
  debtAccountId: string | null;
  /** кредитовое сальдо этого счёта сейчас: сколько ещё записано долгом */
  debtBalance: bigint;
  /** уже выплачено получателю за этот месяц, без сторнированного */
  paid: bigint;
  /** решение участника; у остальных получателей — `null` */
  confirmation: StoredConfirmation | null;
  /** как называть получателя в тексте: имя участника, «Налог НПД», кредитор, «Владелец» */
  label: string;
}

/** Как выплата соотносится с подтверждением: свободна, ждёт срока или нужна причина владельца. */
export type PayGate = { state: "free" } | { state: "wait"; reason: string; until: Date } | { state: "override"; reason: string };

export interface GateInput {
  closedAt: Date | null;
  confirmation: StoredConfirmation | null;
  now: Date;
  confirmDays: number;
}

/**
 * Подтверждение, данное до последнего закрытия месяца, не считается: оно относилось к прежнему отчёту. Обычно снятие
 * закрытия стирает его само, но если сброс не дошёл до базы, выплата не должна пройти по старому слову участника.
 */
export function currentConfirmation(confirmation: StoredConfirmation | null, closedAt: Date | null): StoredConfirmation | null {
  if (confirmation === null || closedAt === null) return null;
  return confirmation.decidedAt.getTime() >= closedAt.getTime() ? confirmation : null;
}

function stamp(at: Date): string {
  return `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC`;
}

/**
 * Можно ли платить получателю. Участнику — после подтверждения; молчит дольше срока (строго дольше) — по решению
 * владельца с причиной; оспорил — только по решению владельца с причиной, в любой день. Остальным получателям
 * подтверждение не нужно: владелец решает за себя, налог и заём — не про участников.
 */
export function payGate(kind: Payee["kind"], input: GateInput): PayGate {
  if (kind !== "stakeholder") return { state: "free" };
  if (input.closedAt === null) return { state: "wait", reason: "Месяц не закрыт: подтверждать пока нечего", until: input.now };
  const decision = currentConfirmation(input.confirmation, input.closedAt);
  if (decision?.status === "confirmed") return { state: "free" };
  if (decision?.status === "disputed") {
    const said = decision.comment === null ? "" : ` («${decision.comment}»)`;
    return { state: "override", reason: `Участник оспорил отчёт${said}: платить можно только по решению владельца с причиной` };
  }
  const until = new Date(input.closedAt.getTime() + input.confirmDays * DAY_MS);
  if (input.now.getTime() > until.getTime()) {
    return { state: "override", reason: `Участник не подтвердил отчёт за ${String(input.confirmDays)} дн.: платить можно по решению владельца с причиной` };
  }
  return { state: "wait", reason: `Участник ещё не подтвердил отчёт: срок на подтверждение до ${stamp(until)}`, until };
}

export interface PayoutCheck {
  payee: Payee;
  facts: PayoutFacts;
  /** место, с которого платят */
  place: { name: string; currency: string };
  /** сумма в минимальных единицах валюты места; `null` — не разобрана, проблема уже названа сборщиком */
  amount: bigint | null;
  overrideReason: string | undefined;
}

const currencyWord = (currency: string): string => (currency === "RUB" ? "в рублях" : `в валюте ${currency}`);

/** Сколько ещё можно выплатить: что месяц должен минус выплаченное, а у участника и налога — не больше сальдо счёта. */
export function remainingOf(payee: Payee["kind"], facts: PayoutFacts): bigint | null {
  if (facts.owed === null) return null;
  const monthly = facts.owed > facts.paid ? facts.owed - facts.paid : 0n;
  // У займа сальдо не предел: премия в учёте не проводится, а транш может её включать — предел только месяц.
  if (payee === "loan") return monthly;
  const booked = facts.debtBalance > 0n ? facts.debtBalance : 0n;
  return monthly < booked ? monthly : booked;
}

/**
 * Всё, что мешает выплате: месяц не закрыт, получателя нет в отчёте, не та валюта, больше остатка, подтверждение.
 * Первые три — отдельные отказы: дальше считать не из чего. Остальные собираются вместе, чтобы владелец исправил их
 * за один заход.
 */
export function payoutProblems(check: PayoutCheck): string[] {
  const { facts, payee, place } = check;
  if (facts.periodStatus !== "closed") return ["Месяц не закрыт: выплата возможна только за закрытый месяц"];
  if (!facts.inReport) return [`Получателя «${facts.label}» нет в отчёте месяца: за него ему ничего не причитается`];
  if (facts.currency !== null && place.currency !== facts.currency) {
    return [`Выплата получателю «${facts.label}» — ${currencyWord(facts.currency)}: у места «${place.name}» валюта ${place.currency}`];
  }

  const problems: string[] = [];
  const remaining = remainingOf(payee.kind, facts);
  if (remaining !== null && check.amount !== null && check.amount > remaining) {
    const spec = currencySpec(place.currency);
    problems.push(`Сумма ${formatMinor(check.amount, spec)} больше остатка долга ${formatMinor(remaining, spec)} ${place.currency}`);
  }

  const gate = payGate(payee.kind, { closedAt: facts.closedAt, confirmation: facts.confirmation, now: facts.now, confirmDays: facts.confirmDays });
  if (gate.state === "wait") problems.push(gate.reason);
  else if (gate.state === "override" && check.overrideReason === undefined) problems.push(gate.reason);
  return problems;
}
