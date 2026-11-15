import { Decimal, fromMinorUnits, isCurrencyCode } from "@bh/fx";
import { formatMinor, periodOf } from "@bh/ledger";
import { ChartRuleError, feeOf, slugify } from "../ledger-chart.js";
import { currencySpec } from "../ledger-currencies.js";
import { Assembly, minorOf, parseAt, placesIn, type BuildResult, type ChartPlace, type OperationsChart } from "./builder-kit.js";
import type { BuildableInput, FeeBody, OperationInput, OperationInputOf } from "./operation-input.js";

export {
  commonProblems,
  operationSourceKey,
  receiptMissingOf,
  transitAccountId,
  type ArticleAccountNeed,
  type BuildProblem,
  type BuildResult,
  type BuiltLoan,
  type BuiltOperation,
  type ChartArticle,
  type ChartPlace,
  type EstimateBasis,
  type OperationsChart,
  type ServiceAccount,
} from "./builder-kit.js";

/**
 * Сборщики проводок по видам операций (docs/37-accounting.md §4 и §6, Р220, tasks/T-0461): перевод, обмен,
 * расход, поступление, заём. Общие правила — суммы, места, статьи, комиссии, дата — в `builder-kit.ts`.
 */

function buildTransfer(a: Assembly, input: OperationInputOf<"transfer">): BuildResult {
  const from = a.place(input.from, "Откуда");
  const to = a.place(input.to, "Куда");
  if (from !== null && to !== null) {
    if (from.accountId === to.accountId) a.problems.push({ message: "Откуда и куда — одно и то же место" });
    else if (from.currency !== to.currency) {
      a.problems.push({ message: `Перевод — в одной валюте: у «${from.name}» это ${from.currency}, у «${to.name}» — ${to.currency}; для разных валют есть обмен` });
    }
  }
  if (from === null || to === null) return a.finish({ estimate: [] });
  const amount = a.amount(input.amount, from.currency, "Сумма");
  a.fees("transfer", input.fee, from);
  if (amount === null) return a.finish({ estimate: [] });
  a.lines.add(from.accountId, -amount);
  a.lines.add(to.accountId, amount);
  return a.finish({ estimate: [{ currency: from.currency, minor: amount }] });
}

function buildExchange(a: Assembly, input: OperationInputOf<"exchange">): BuildResult {
  const from = a.place(input.from, "Откуда");
  const to = a.place(input.to, "Куда");
  if (from !== null && to !== null) {
    if (from.currency === to.currency) a.problems.push({ message: `Обмен — между разными валютами, а у «${from.name}» и «${to.name}» это ${from.currency}: для одной валюты есть перевод` });
  }
  a.receipt(input.receipt, to);
  if (from === null || to === null) return a.finish({ estimate: [] });
  const given = a.amount(input.given, from.currency, "Отдано");
  const received = a.amount(input.received, to.currency, "Получено");
  a.fees("exchange", input.fee, from);
  if (given === null || received === null) return a.finish({ estimate: [] });
  // Каждая валюта сходится сама: отданное уходит на транзит своей валюты, полученное приходит с транзита своей.
  a.lines.add(from.accountId, -given);
  a.lines.add(a.transit(from.currency), given);
  a.lines.add(a.transit(to.currency), -received);
  a.lines.add(to.accountId, received);
  if (isCurrencyCode(from.currency) && isCurrencyCode(to.currency)) {
    // Курс — частное двух фактических сумм в единицах валют: сколько единиц полученной за одну отданной.
    const rate = fromMinorUnits(received, to.currency).div(fromMinorUnits(given, from.currency));
    a.meta.rate = rate.toSignificantDigits(12).toFixed();
    a.meta.ratePair = `${from.currency}→${to.currency}`;
  }
  return a.finish({
    estimate: [
      { currency: from.currency, minor: given },
      { currency: to.currency, minor: received },
    ],
  });
}

function buildExpense(a: Assembly, input: OperationInputOf<"expense">): BuildResult {
  const from = a.place(input.from, "Откуда");
  const article = a.article(input.article, "expense");
  if (from === null) return a.finish({ estimate: [] });
  const amount = a.amount(input.amount, from.currency, "Сумма");
  if (amount === null || article === null) return a.finish({ estimate: [] });
  a.lines.add(from.accountId, -amount);
  a.articleLine(article, from.currency, amount);
  return a.finish({ estimate: [{ currency: from.currency, minor: amount }] });
}

function buildIncome(a: Assembly, input: OperationInputOf<"income">): BuildResult {
  const to = a.place(input.to, "Куда");
  const article = a.article(input.article, "income");
  const at = parseAt(input.at);
  // «За какой месяц» — не позже месяца события: выручка сети приходит после её месяца, а не раньше (О51).
  if (at !== null && input.forMonth > periodOf(at)) a.problems.push({ message: `Месяц поступления ${input.forMonth} позже месяца даты операции` });
  a.meta.forMonth = input.forMonth;
  a.receipt(input.receipt, to);
  if (to === null) return a.finish({ estimate: [] });
  const amount = a.amount(input.amount, to.currency, "Сумма");
  if (amount === null || article === null) return a.finish({ estimate: [] });
  a.lines.add(to.accountId, amount);
  a.articleLine(article, to.currency, -amount);
  return a.finish({ estimate: [{ currency: to.currency, minor: amount }] });
}

function buildLoan(a: Assembly, input: OperationInputOf<"loan">): BuildResult {
  const to = a.place(input.to, "Куда");
  const lender = input.lender.trim();
  let slug: string | null = null;
  try {
    slug = slugify(lender);
  } catch (error: unknown) {
    if (!(error instanceof ChartRuleError)) throw error;
    a.problems.push({ message: `Кредитор: ${error.message}` });
  }
  if (!Number.isInteger(input.repaymentBp) || input.repaymentBp < 0 || input.repaymentBp > 10_000) {
    a.problems.push({ message: "Ставка погашения — доля чистой прибыли от 0 до 100 % (от 0 до 10 000 сотых процента)" });
  }
  if (to === null) return a.finish({ estimate: [] });
  const principal = a.amount(input.amount, to.currency, "Сумма займа");
  const premium = a.amount(input.premium, to.currency, "Премия", "nonnegative");
  if (principal === null || premium === null || slug === null) return a.finish({ estimate: [] });
  const accountId = `loan.${slug}.${to.currency}`;
  a.serviceAccounts.set(accountId, { accountId, type: "liability", currency: to.currency, name: `Заём: ${lender}` });
  a.lines.add(to.accountId, principal);
  a.lines.add(accountId, -principal);
  a.meta.lender = lender;
  a.meta.premium = formatMinor(premium, currencySpec(to.currency));
  a.meta.repaymentBp = input.repaymentBp;
  return a.finish({
    loan: { lender, accountId, currency: to.currency, principal, premium, repaymentBp: input.repaymentBp },
    estimate: [{ currency: to.currency, minor: principal }],
  });
}

/**
 * Собрать проводку операции. Ничего не пишет: на выходе проводка с ключом `op:<id>`, счета, которые нужно завести
 * до записи, условия займа и оценка в долларах — или все найденные проблемы разом, чтобы человек исправил их за
 * один заход.
 */
export function buildOperation(operationId: string, input: BuildableInput, chart: OperationsChart, now: Date): BuildResult {
  const assembly = new Assembly(operationId, input, chart, now);
  switch (input.kind) {
    case "transfer":
      return buildTransfer(assembly, input);
    case "exchange":
      return buildExchange(assembly, input);
    case "expense":
      return buildExpense(assembly, input);
    case "income":
      return buildIncome(assembly, input);
    case "loan":
      return buildLoan(assembly, input);
  }
}

/** Комиссия по шаблону места списания: процент округлён вверх (`feeOf`), фикса — в своей валюте. */
function templateFee(input: OperationInputOf<"transfer"> | OperationInputOf<"exchange">, from: ChartPlace): FeeBody | undefined {
  if (!isCurrencyCode(from.currency)) return undefined;
  const base = minorOf(input.kind === "transfer" ? input.amount : input.given, from.currency, "Сумма", [], "positive");
  if (base === null) return undefined;
  const lines = feeOf(base, from.fee, currencySpec(from.currency));
  const percent = lines.find((line) => line.kind === "percent");
  const fixed = lines.find((line) => line.kind === "fixed");
  if (percent === undefined && fixed === undefined) return undefined;
  return {
    ...(percent === undefined ? {} : { amount: formatMinor(percent.amount, currencySpec(percent.currency)) }),
    ...(fixed === undefined || !isCurrencyCode(fixed.currency) ? {} : { fixed: { amount: formatMinor(fixed.amount, currencySpec(fixed.currency)), currency: fixed.currency } }),
  };
}

/**
 * Фикса в чужой валюте без названного места, а место единственное, — закрепить его в комиссии. Иначе заведённое
 * потом второе место в этой валюте сделало бы старый черновик неоднозначным: он собирался бы по-другому, чем его
 * проверили при вводе.
 */
function pinFixedPayer(fee: FeeBody, from: ChartPlace, chart: OperationsChart): FeeBody {
  const fixed = fee.fixed;
  if (fixed === undefined || fixed.from !== undefined || fixed.currency === from.currency) return fee;
  const [only, ...rest] = placesIn(chart, fixed.currency);
  return only === undefined || rest.length > 0 ? fee : { ...fee, fixed: { ...fixed, from: only.accountId } };
}

/**
 * Подготовить комиссию перевода и обмена к записи: не задана — подставить шаблон места списания, задана —
 * оставить как есть; фиксу в чужой валюте с единственным местом закрепить за этим местом. Шаблон — подсказка:
 * подставленное попадает в ввод и дальше правится руками, а проводится ровно то, что лежит в операции, поэтому
 * смена шаблона или справочника между черновиком и проведением на проводку не влияет. Пустая комиссия `{}` —
 * «комиссии нет, хотя шаблон есть» — не трогается.
 */
export function applyFeeTemplate(input: OperationInput, chart: OperationsChart): OperationInput {
  if (input.kind !== "transfer" && input.kind !== "exchange") return input;
  const from = chart.places.get(input.from);
  if (from === undefined) return input;
  const fee = input.fee ?? templateFee(input, from);
  if (fee === undefined) return input;
  const pinned = pinFixedPayer(fee, from, chart);
  return pinned === input.fee ? input : { ...input, fee: pinned };
}

/** Размер операции в долларах: сумма в валюте × курс. Считает сервис (курсы — его дело), здесь — только округление. */
export function roundUsd(usd: Decimal): string | null {
  const rounded = usd.toDecimalPlaces(2, Decimal.ROUND_UP);
  // numeric(18,2) в базе: больше — не оценка, а мусор; неизвестное сервис всё равно считает «не мелочью».
  return rounded.abs().lt(new Decimal("1e15")) ? rounded.toFixed(2) : null;
}
