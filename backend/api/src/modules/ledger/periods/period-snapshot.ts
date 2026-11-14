import { z } from "zod";
import { CHECKLIST_CODES } from "./checklist.js";

/**
 * Снимок закрытия месяца (docs/37-accounting.md §13, Р222, tasks/T-0468): всё, чем посчитано закрытие, и его
 * итог. Лежит в `ledger_period.snapshot` как JSON, поэтому суммы — десятичными строками (`bigint` в JSON не ходит),
 * а читается он схемой, а не приведением типа: данные из базы доверия не заслуживают. Ставки, доли, займы и курсы
 * хранятся здесь же, и их смена потом прошлое не трогает; по снимку месяц пересчитывается без базы
 * (`recomputeFromSnapshot`).
 */

/** Целое число десятичной строкой: суммы в минимальных единицах, центы доллара. */
const amount = z.string().regex(/^-?\d+$/u);
const count = z.number().int().min(0);

const rate = z.object({ usdPerUnit: z.string().min(1), at: z.string().min(1), stale: z.boolean() });
const payer = z.enum(["individual", "legal"]);

const line = z.object({ key: z.string(), amount });

export const waterfallSchema = z.object({
  revenue: z.array(line),
  otherIncome: z.array(line),
  expenses: z.array(line),
  grossRevenue: amount,
  totalExpenses: amount,
  profitBeforeTax: amount,
  tax: amount,
  netProfit: amount,
  tranches: z.array(z.object({ loanId: z.string(), amount, remainingAfter: amount })),
  toDistribute: amount,
  payouts: z.array(z.object({ accountId: z.string(), bp: count, amount })),
  ownerAmount: amount,
  noDistribution: z.boolean(),
});

const checklistItem = z.object({
  code: z.enum(CHECKLIST_CODES),
  severity: z.enum(["blocker", "warning"]),
  count,
  message: z.string(),
  refs: z.array(z.object({ kind: z.enum(["operation", "purchase", "entry", "rate"]), id: z.string() })),
  moreRefs: count,
});

export const snapshotSchema = z.object({
  version: z.literal(1),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),
  closedAt: z.string().min(1),
  /** какой по счёту раз закрыт месяц: сколько раз закрытие снимали до этого */
  round: count,
  settings: z.object({ npdRateIndividualBp: count, npdRateLegalBp: count, npdYearLimitRub: count, npdWarnPercent: count }),
  /** курс рубля на день закрытия; пусто, если рубли закрытию не понадобились */
  rubRate: rate.nullable(),
  /** названия счетов водопада и участников — отчёт читается без справочника */
  accounts: z.record(z.string(), z.string()),
  buckets: z.array(
    z.object({
      accountId: z.string(),
      group: z.enum(["revenue", "income", "expense"]),
      currency: z.string(),
      usdPerUnit: z.string().min(1),
      rateAt: z.string().min(1),
      stale: z.boolean(),
      minor: amount,
    }),
  ),
  receipts: z.array(z.object({ sourceKey: z.string(), at: z.string(), period: z.string(), payer, rubMinor: amount, number: z.string().nullable(), link: z.string().nullable() })),
  tax: z.object({ byPayer: z.array(z.object({ payer, rubMinor: amount, bp: count, taxMinor: amount })), taxMinor: amount, usdCents: amount }),
  loans: z.array(
    z.object({
      loanId: z.string(),
      lender: z.string(),
      currency: z.string(),
      usdPerUnit: z.string().min(1),
      remainingMinor: amount,
      remainingUsdCents: amount,
      repaymentBp: count,
      trancheUsdCents: amount,
      trancheMinor: amount,
    }),
  ),
  shares: z.array(z.object({ accountId: z.string(), bp: count })),
  waterfall: waterfallSchema,
  rub: z.object({
    taxMinor: amount,
    payouts: z.array(z.object({ accountId: z.string(), bp: count, usdCents: amount, rubMinor: amount })),
    ownerUsdCents: amount,
  }),
  /** ключи проводок закрытия: по ним сторнируется снятие закрытия */
  entries: z.array(z.string()),
  warnings: z.array(checklistItem),
});

export type PeriodSnapshot = z.infer<typeof snapshotSchema>;
export type SnapshotWaterfall = z.infer<typeof waterfallSchema>;
export type SnapshotRub = PeriodSnapshot["rub"];

/** Снимок из JSON базы. Не снимок — исключение: показать отчёт «как получится» из повреждённых данных нельзя. */
export function parseSnapshot(value: unknown): PeriodSnapshot {
  return snapshotSchema.parse(value);
}
