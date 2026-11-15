/**
 * Водопад месяца (docs/11-revenue-split.md §3, docs/37-accounting.md §13, Р222):
 * выручка → расходы → налог → транш займа → прибыль к разделу → доли.
 *
 * Считается в минимальных единицах одной валюты отчёта: вход уже пересчитан
 * вызывающим по курсу дня каждой проводки. Налог — готовая сумма (ставки НПД
 * ядро не знает, Р221). Округление — всегда вниз до единицы; копейки остатка
 * достаются владельцу, поэтому сумма выплат и доли владельца равна прибыли к
 * разделу точно.
 */

export interface WaterfallLine {
  key: string;
  amount: bigint;
}

export interface WaterfallLoan {
  loanId: string;
  /** сколько ещё не погашено, в валюте отчёта */
  remaining: bigint;
  /** доля чистой прибыли месяца на погашение, в базисных пунктах (1 bp = 0,01 %) */
  repaymentBp: number;
}

export interface WaterfallShare {
  accountId: string;
  /** доля участника в разделе, в базисных пунктах */
  bp: number;
}

export interface WaterfallInput {
  /** по площадкам и источникам */
  revenue: WaterfallLine[];
  otherIncome: WaterfallLine[];
  /** построчно, включая начисления партнёрам */
  expenses: WaterfallLine[];
  /** налог периода в валюте отчёта */
  tax: bigint;
  /** по очереди входа: первый погашается раньше */
  loans: WaterfallLoan[];
  /** доли участников месяца, сумма не больше 10 000 */
  shares: WaterfallShare[];
}

export interface WaterfallTranche {
  loanId: string;
  amount: bigint;
  remainingAfter: bigint;
}

export interface WaterfallPayout {
  accountId: string;
  bp: number;
  amount: bigint;
}

export interface WaterfallResult {
  grossRevenue: bigint;
  totalExpenses: bigint;
  profitBeforeTax: bigint;
  tax: bigint;
  /** может быть отрицательной: убыток виден в отчёте как есть */
  netProfit: bigint;
  tranches: WaterfallTranche[];
  toDistribute: bigint;
  payouts: WaterfallPayout[];
  ownerAmount: bigint;
  /** чистая прибыль ноль или меньше: траншей и выплат нет */
  noDistribution: boolean;
}

export const BASIS_POINTS = 10_000;

function assertNonNegative(value: bigint, what: string): void {
  if (value < 0n) {
    throw new RangeError(`${what}: сумма не может быть отрицательной, получено ${value}`);
  }
}

function assertBasisPoints(bp: number, what: string): void {
  if (!Number.isInteger(bp) || bp < 0 || bp > BASIS_POINTS) {
    throw new RangeError(`${what}: доля должна быть целым числом базисных пунктов от 0 до ${BASIS_POINTS}, получено ${bp}`);
  }
}

function sumLines(lines: readonly WaterfallLine[], group: string): bigint {
  let sum = 0n;
  for (const line of lines) {
    assertNonNegative(line.amount, `${group} «${line.key}»`);
    sum += line.amount;
  }
  return sum;
}

function validate(input: WaterfallInput): void {
  assertNonNegative(input.tax, "Налог");
  for (const loan of input.loans) {
    assertNonNegative(loan.remaining, `Заём «${loan.loanId}»`);
    assertBasisPoints(loan.repaymentBp, `Заём «${loan.loanId}»`);
  }
  let shareSum = 0;
  for (const share of input.shares) {
    assertBasisPoints(share.bp, `Участник «${share.accountId}»`);
    shareSum += share.bp;
  }
  if (shareSum > BASIS_POINTS) {
    throw new RangeError(`Сумма долей участников ${shareSum} bp больше ${BASIS_POINTS} (100 %)`);
  }
}

/** Доля суммы вниз до единицы: bigint-деление округляет к нулю, а сумма здесь неотрицательна. */
function portion(amount: bigint, bp: number): bigint {
  return (amount * BigInt(bp)) / BigInt(BASIS_POINTS);
}

/**
 * Порядок строго по docs/11 §3: прибыль до налога = выручка + прочее − расходы;
 * чистая = до налога − налог; транши по займам по очереди входа, каждый —
 * `min(остаток, floor(чистая × bp / 10 000))`, а все вместе не больше чистой
 * прибыли; к разделу — чистая минус транши; выплаты — `floor(к разделу × bp /
 * 10 000)`; владельцу — остаток.
 *
 * Недопустимый вход (отрицательная сумма, доля вне 0…10 000, сумма долей больше
 * 100 %) — исключение: молча «поправленная» сумма в учёте хуже остановки.
 */
export function computeWaterfall(input: WaterfallInput): WaterfallResult {
  validate(input);
  const grossRevenue = sumLines(input.revenue, "Выручка");
  const otherIncome = sumLines(input.otherIncome, "Прочий доход");
  const totalExpenses = sumLines(input.expenses, "Расход");
  const profitBeforeTax = grossRevenue + otherIncome - totalExpenses;
  const netProfit = profitBeforeTax - input.tax;
  const noDistribution = netProfit <= 0n;

  const tranches: WaterfallTranche[] = [];
  let tranchesTotal = 0n;
  for (const loan of input.loans) {
    let amount = 0n;
    if (!noDistribution) {
      const wanted = portion(netProfit, loan.repaymentBp);
      const room = netProfit - tranchesTotal;
      amount = [wanted, loan.remaining, room].reduce((least, value) => (value < least ? value : least));
    }
    tranchesTotal += amount;
    tranches.push({ loanId: loan.loanId, amount, remainingAfter: loan.remaining - amount });
  }

  const toDistribute = noDistribution ? 0n : netProfit - tranchesTotal;
  const payouts: WaterfallPayout[] = input.shares.map((share) => ({
    accountId: share.accountId,
    bp: share.bp,
    amount: portion(toDistribute, share.bp),
  }));
  const paidOut = payouts.reduce((sum, payout) => sum + payout.amount, 0n);

  return {
    grossRevenue,
    totalExpenses,
    profitBeforeTax,
    tax: input.tax,
    netProfit,
    tranches,
    toDistribute,
    payouts,
    ownerAmount: toDistribute - paidOut,
    noDistribution,
  };
}
