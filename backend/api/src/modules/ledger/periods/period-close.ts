import { CURRENCIES, Decimal, isCurrencyCode } from "@bh/fx";
import { computeWaterfall, type AccountType, type WaterfallResult } from "@bh/ledger";
import type { ChecklistItem } from "./checklist.js";
import { npdTax, usdCentsOf, waterfallLines, wholeCents, type BucketCore, type NpdPayerTax, type Receipt, type ReceiptPayer, type ValuedBucket, type WaterfallLines } from "./period-facts.js";
import { closeKey } from "./period-rules.js";
import type { PeriodSnapshot, SnapshotRub, SnapshotWaterfall } from "./period-snapshot.js";
import type { CloseEntry, NewServiceAccount } from "./period-types.js";

/**
 * Закрытие месяца: водопад, налог и долги участникам в рублях (docs/37-accounting.md §13, docs/11-revenue-split.md
 * §3, Р222, tasks/T-0468). Чистые функции: оценённые корзины, чеки, займы и доли приходят аргументами, на выходе —
 * итог, снимок и проводки. Считается в центах доллара; налог и долги участникам — в рублях по курсу рубля дня
 * закрытия. Один и тот же расчёт идёт и при закрытии, и при пересчёте из снимка (`recomputeFromSnapshot`).
 */

export interface PeriodSettings {
  npdRateIndividualBp: number;
  npdRateLegalBp: number;
  npdYearLimitRub: number;
  npdWarnPercent: number;
}

export interface RubRate {
  /** цена рубля в долларах */
  usdPerUnit: string;
  at: string;
  stale: boolean;
}

/** Заём к погашению: остаток в валюте займа (тело и премия минус погашенное) и курс валюты на день закрытия. */
export interface CloseLoan {
  loanId: string;
  lender: string;
  currency: string;
  remainingMinor: bigint;
  repaymentBp: number;
  usdPerUnit: string;
}

export interface CloseShare {
  accountId: string;
  bp: number;
  name: string;
}

export interface CloseInput {
  period: string;
  round: number;
  closedAt: Date;
  settings: PeriodSettings;
  buckets: readonly ValuedBucket[];
  receipts: readonly Receipt[];
  /** курс рубля на день закрытия; `null` допустим, только если рубли не понадобились (нет чеков и участников) */
  rubRate: RubRate | null;
  /** в порядке входа: первый погашается раньше */
  loans: readonly CloseLoan[];
  shares: readonly CloseShare[];
  warnings: readonly ChecklistItem[];
}

export interface LoanTranche {
  loanId: string;
  lender: string;
  currency: string;
  usdPerUnit: string;
  remainingMinor: bigint;
  remainingUsdCents: bigint;
  repaymentBp: number;
  trancheUsdCents: bigint;
  /** то же в валюте займа: так остаток убывает от месяца к месяцу */
  trancheMinor: bigint;
}

export interface RubPayout {
  accountId: string;
  bp: number;
  usdCents: bigint;
  rubMinor: bigint;
}

export interface CloseResult {
  snapshot: PeriodSnapshot;
  tax: { taxMinor: bigint; usdCents: bigint; byPayer: NpdPayerTax[] };
  waterfall: WaterfallResult;
  loans: LoanTranche[];
  rub: { taxMinor: bigint; ownerUsdCents: bigint; payouts: RubPayout[] };
}

interface CalcArgs {
  buckets: readonly BucketCore[];
  receipts: readonly { payer: ReceiptPayer; rubMinor: bigint }[];
  settings: PeriodSettings;
  rubUsdPerUnit: string | null;
  loans: readonly CloseLoan[];
  shares: readonly { accountId: string; bp: number }[];
}

interface Calc {
  lines: WaterfallLines;
  tax: CloseResult["tax"];
  loans: LoanTranche[];
  waterfall: WaterfallResult;
  rub: CloseResult["rub"];
}

/** Остаток займа в центах доллара, вниз: погасить больше, чем осталось, транш не может. */
function remainingUsdCents(loan: CloseLoan): bigint {
  return wholeCents(usdCentsOf({ currency: loan.currency, usdPerUnit: loan.usdPerUnit, minor: loan.remainingMinor }), "down");
}

/** Транш в валюте займа: целиком, если упёрся в остаток, иначе по курсу дня вниз — остаток не уходит в минус. */
function trancheMinor(loan: CloseLoan, trancheUsdCents: bigint, remaining: bigint): bigint {
  if (trancheUsdCents === 0n) return 0n;
  if (trancheUsdCents >= remaining) return loan.remainingMinor;
  if (!isCurrencyCode(loan.currency)) throw new Error(`Валюта займа «${loan.currency}» не входит в справочник курсов`);
  const minor = new Decimal(trancheUsdCents.toString()).div(100).div(new Decimal(loan.usdPerUnit)).mul(new Decimal(10).pow(CURRENCIES[loan.currency].decimals));
  const floored = BigInt(minor.toDecimalPlaces(0, Decimal.ROUND_DOWN).toFixed(0));
  return floored > loan.remainingMinor ? loan.remainingMinor : floored;
}

function calculate(args: CalcArgs): Calc {
  const lines = waterfallLines(args.buckets);
  const needRub = args.receipts.length > 0 || args.shares.length > 0;
  if (needRub && args.rubUsdPerUnit === null) throw new RangeError("Закрыть нельзя: курс рубля на день закрытия неизвестен, а налог и долги участникам считаются в рублях");
  const rubRate = args.rubUsdPerUnit === null ? null : new Decimal(args.rubUsdPerUnit);

  const npd = npdTax(args.receipts, { individualBp: args.settings.npdRateIndividualBp, legalBp: args.settings.npdRateLegalBp });
  // копейка × доллары за рубль = центы: 0,01 ₽ × курс × 100 центов
  const taxUsdCents = npd.taxMinor === 0n || rubRate === null ? 0n : wholeCents(new Decimal(npd.taxMinor.toString()).mul(rubRate), "up");

  const remaining = args.loans.map(remainingUsdCents);
  const waterfall = computeWaterfall({
    revenue: lines.revenue,
    otherIncome: lines.otherIncome,
    expenses: lines.expenses,
    tax: taxUsdCents,
    loans: args.loans.map((loan, index) => ({ loanId: loan.loanId, remaining: remaining[index] ?? 0n, repaymentBp: loan.repaymentBp })),
    shares: args.shares.map((share) => ({ accountId: share.accountId, bp: share.bp })),
  });

  const loans: LoanTranche[] = args.loans.map((loan, index) => {
    const tranche = waterfall.tranches[index];
    const trancheUsdCents = tranche?.amount ?? 0n;
    const left = remaining[index] ?? 0n;
    return {
      loanId: loan.loanId,
      lender: loan.lender,
      currency: loan.currency,
      usdPerUnit: loan.usdPerUnit,
      remainingMinor: loan.remainingMinor,
      remainingUsdCents: left,
      repaymentBp: loan.repaymentBp,
      trancheUsdCents,
      trancheMinor: trancheMinor(loan, trancheUsdCents, left),
    };
  });

  // доллары в рубли вниз до копейки: участнику не записывается больше, чем посчитано
  const payouts: RubPayout[] = waterfall.payouts.map((payout) => ({
    accountId: payout.accountId,
    bp: payout.bp,
    usdCents: payout.amount,
    rubMinor: payout.amount === 0n || rubRate === null ? 0n : BigInt(new Decimal(payout.amount.toString()).div(rubRate).toDecimalPlaces(0, Decimal.ROUND_DOWN).toFixed(0)),
  }));

  return {
    lines,
    tax: { taxMinor: npd.taxMinor, usdCents: taxUsdCents, byPayer: npd.byPayer },
    loans,
    waterfall,
    rub: { taxMinor: npd.taxMinor, ownerUsdCents: waterfall.ownerAmount, payouts },
  };
}

const text = (value: bigint): string => value.toString();

function serializeWaterfall(lines: WaterfallLines, result: WaterfallResult): SnapshotWaterfall {
  const serializeLines = (list: WaterfallLines["revenue"]) => list.map((entry) => ({ key: entry.key, amount: text(entry.amount) }));
  return {
    revenue: serializeLines(lines.revenue),
    otherIncome: serializeLines(lines.otherIncome),
    expenses: serializeLines(lines.expenses),
    grossRevenue: text(result.grossRevenue),
    totalExpenses: text(result.totalExpenses),
    profitBeforeTax: text(result.profitBeforeTax),
    tax: text(result.tax),
    netProfit: text(result.netProfit),
    tranches: result.tranches.map((tranche) => ({ loanId: tranche.loanId, amount: text(tranche.amount), remainingAfter: text(tranche.remainingAfter) })),
    toDistribute: text(result.toDistribute),
    payouts: result.payouts.map((payout) => ({ accountId: payout.accountId, bp: payout.bp, amount: text(payout.amount) })),
    ownerAmount: text(result.ownerAmount),
    noDistribution: result.noDistribution,
  };
}

function serializeRub(rub: CloseResult["rub"]): SnapshotRub {
  return {
    taxMinor: text(rub.taxMinor),
    payouts: rub.payouts.map((payout) => ({ accountId: payout.accountId, bp: payout.bp, usdCents: text(payout.usdCents), rubMinor: text(payout.rubMinor) })),
    ownerUsdCents: text(rub.ownerUsdCents),
  };
}

/** Какие проводки нужны: налог — если он есть, долг — каждому участнику с ненулевой суммой в рублях. */
function plannedKeys(period: string, round: number, rub: Pick<CloseResult["rub"], "taxMinor" | "payouts">): string[] {
  const keys: string[] = [];
  if (rub.taxMinor > 0n) keys.push(closeKey(period, round, "tax"));
  for (const payout of rub.payouts) if (payout.rubMinor > 0n) keys.push(closeKey(period, round, `payout:${payout.accountId}`));
  return keys;
}

/**
 * Закрытие месяца: налог НПД с чеков, водопад, долги участникам в рублях и снимок. Исключение — нет курса рубля,
 * а чеки или участники есть: считать их в рублях по выдуманному нулю нельзя (сервис до этого не доводит — курс
 * рубля на день закрытия у него блокер чек-листа).
 */
export function computeClose(input: CloseInput): CloseResult {
  const calc = calculate({
    buckets: input.buckets,
    receipts: input.receipts,
    settings: input.settings,
    rubUsdPerUnit: input.rubRate?.usdPerUnit ?? null,
    loans: input.loans,
    shares: input.shares,
  });
  const accounts: Record<string, string> = {};
  for (const bucket of input.buckets) accounts[bucket.accountId] = bucket.accountName;
  for (const share of input.shares) accounts[share.accountId] = share.name;

  const snapshot: PeriodSnapshot = {
    version: 1,
    period: input.period,
    closedAt: input.closedAt.toISOString(),
    round: input.round,
    settings: { ...input.settings },
    rubRate: input.rubRate === null ? null : { ...input.rubRate },
    accounts,
    buckets: input.buckets.map((bucket) => ({ accountId: bucket.accountId, group: bucket.group, currency: bucket.currency, usdPerUnit: bucket.usdPerUnit, rateAt: bucket.rateAt, stale: bucket.stale, minor: text(bucket.minor) })),
    receipts: input.receipts.map((receipt) => ({ sourceKey: receipt.sourceKey, at: receipt.at.toISOString(), period: receipt.period, payer: receipt.payer, rubMinor: text(receipt.rubMinor), number: receipt.number, link: receipt.link })),
    tax: { byPayer: calc.tax.byPayer.map((line) => ({ payer: line.payer, rubMinor: text(line.rubMinor), bp: line.bp, taxMinor: text(line.taxMinor) })), taxMinor: text(calc.tax.taxMinor), usdCents: text(calc.tax.usdCents) },
    loans: calc.loans.map((loan) => ({
      loanId: loan.loanId,
      lender: loan.lender,
      currency: loan.currency,
      usdPerUnit: loan.usdPerUnit,
      remainingMinor: text(loan.remainingMinor),
      remainingUsdCents: text(loan.remainingUsdCents),
      repaymentBp: loan.repaymentBp,
      trancheUsdCents: text(loan.trancheUsdCents),
      trancheMinor: text(loan.trancheMinor),
    })),
    shares: input.shares.map((share) => ({ accountId: share.accountId, bp: share.bp })),
    waterfall: serializeWaterfall(calc.lines, calc.waterfall),
    rub: serializeRub(calc.rub),
    entries: plannedKeys(input.period, input.round, calc.rub),
    warnings: input.warnings.map((warning) => ({ ...warning, refs: warning.refs.map((ref) => ({ ...ref })) })),
  };
  return { snapshot, tax: calc.tax, waterfall: calc.waterfall, loans: calc.loans, rub: calc.rub };
}

/**
 * Пересчёт из снимка без базы и без настроек: ставки, доли, займы и курсы берутся из него же. Совпадение с
 * записанным итогом — проверка того, что снимок хранит всё нужное; а отчёт закрытого месяца не зависит от того,
 * что поменяли после закрытия.
 */
export function recomputeFromSnapshot(snapshot: PeriodSnapshot): { waterfall: SnapshotWaterfall; rub: SnapshotRub } {
  const calc = calculate({
    buckets: snapshot.buckets.map((bucket) => ({ accountId: bucket.accountId, group: bucket.group, currency: bucket.currency, usdPerUnit: bucket.usdPerUnit, minor: BigInt(bucket.minor) })),
    receipts: snapshot.receipts.map((receipt) => ({ payer: receipt.payer, rubMinor: BigInt(receipt.rubMinor) })),
    settings: snapshot.settings,
    rubUsdPerUnit: snapshot.rubRate?.usdPerUnit ?? null,
    loans: snapshot.loans.map((loan) => ({ loanId: loan.loanId, lender: loan.lender, currency: loan.currency, remainingMinor: BigInt(loan.remainingMinor), repaymentBp: loan.repaymentBp, usdPerUnit: loan.usdPerUnit })),
    shares: snapshot.shares,
  });
  return { waterfall: serializeWaterfall(calc.lines, calc.waterfall), rub: serializeRub(calc.rub) };
}

const TAX_EXPENSE = "expense.tax_accrued.RUB";
const TAX_LIABILITY = "liability.tax.RUB";
const DISTRIBUTION = "equity.distribution.RUB";

const MAX_ACCOUNT_NAME = 128;

function account(accountId: string, type: AccountType, name: string): NewServiceAccount {
  return { accountId, type, currency: "RUB", name: name.slice(0, MAX_ACCOUNT_NAME) };
}

/**
 * Проводки закрытия: начисление налога (`расход +, обязательство −`) и долг каждому участнику (`распределение +,
 * обязательство перед участником −`), все в рублях, дата — день закрытия, месяц — закрываемый. Доля владельца
 * долгом не проводится: она в отчёте, а забирается выплатой по желанию (Р222). Счета, нужные проводкам, —
 * в списке, чтобы заводить их заранее: `INSERT … ON CONFLICT DO NOTHING`.
 */
export function closeEntries(result: CloseResult): { accounts: NewServiceAccount[]; entries: CloseEntry[] } {
  const { snapshot } = result;
  const at = new Date(snapshot.closedAt);
  const accounts = new Map<string, NewServiceAccount>();
  const entries: CloseEntry[] = [];
  const meta = (kind: string, extra: Record<string, string> = {}) => ({ closePeriod: snapshot.period, closeRound: snapshot.round, closeKind: kind, ...extra });

  if (result.rub.taxMinor > 0n) {
    accounts.set(TAX_EXPENSE, account(TAX_EXPENSE, "expense", "Налог НПД: начислено"));
    accounts.set(TAX_LIABILITY, account(TAX_LIABILITY, "liability", "Налог НПД: к уплате"));
    entries.push({
      sourceKey: closeKey(snapshot.period, snapshot.round, "tax"),
      at,
      period: snapshot.period,
      memo: `Закрытие ${snapshot.period}: начисление налога НПД`,
      lines: [
        { accountId: TAX_EXPENSE, amount: result.rub.taxMinor },
        { accountId: TAX_LIABILITY, amount: -result.rub.taxMinor },
      ],
      meta: meta("tax"),
    });
  }
  for (const payout of result.rub.payouts) {
    if (payout.rubMinor === 0n) continue;
    const debt = `liability.stakeholder.${payout.accountId}.RUB`;
    const name = snapshot.accounts[payout.accountId] ?? payout.accountId;
    accounts.set(DISTRIBUTION, account(DISTRIBUTION, "equity", "Распределение прибыли участникам, ₽"));
    accounts.set(debt, account(debt, "liability", `Участник проекта: ${name}`));
    entries.push({
      sourceKey: closeKey(snapshot.period, snapshot.round, `payout:${payout.accountId}`),
      at,
      period: snapshot.period,
      memo: `Закрытие ${snapshot.period}: долг участнику ${name}`,
      lines: [
        { accountId: DISTRIBUTION, amount: payout.rubMinor },
        { accountId: debt, amount: -payout.rubMinor },
      ],
      meta: meta("payout", { stakeholder: payout.accountId }),
    });
  }
  return { accounts: [...accounts.values()], entries };
}
