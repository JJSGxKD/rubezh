import { withTimeout } from "../../../common/with-timeout.js";
import { SETTINGS } from "../../settings/setting-catalog.js";
import type { SettingsReader } from "../../settings/settings.service.js";
import type { OperationInputOf } from "../operations/operation-input.js";
import type { PeriodSnapshot } from "../periods/period-snapshot.js";
import { parseSnapshot } from "../periods/period-snapshot.js";
import { TAX_DEBT_ACCOUNT, parsePayee, stakeholderDebtAccount, type Payee } from "./payee.js";
import type { PayoutFacts } from "./payout-rules.js";
import type { PayoutRecord, PayoutsRepository } from "./payouts.repository.js";

/**
 * Данные месяца для выплаты (docs/37-accounting.md §13, Р222, tasks/T-0469): читаются из базы один раз и отдаются
 * сборщику готовыми — он остаётся чистой функцией. Что месяц должен получателю — из снимка закрытия (суммы в рублях по
 * курсу дня закрытия), а не из пересчёта: смена ставок, долей и курсов потом прошлое не трогает.
 */

export const DB_TIMEOUT_MS = 10_000;

/** Запрос к базе с потолком ожидания: зависший запрос не держит ни выплату, ни панель. */
export async function db<T>(promise: Promise<T>): Promise<T> {
  return await withTimeout(promise, DB_TIMEOUT_MS, "база учёта");
}

const sumOf = (records: readonly PayoutRecord[], payee: string): bigint => records.filter((record) => record.payee === payee).reduce((sum, record) => sum + record.minor, 0n);

const sumOnAccount = (records: readonly PayoutRecord[], accountId: string): bigint => records.filter((record) => record.accountId === accountId).reduce((sum, record) => sum + record.minor, 0n);

/** Что снимок месяца говорит о получателе: сколько ему причитается (`null` — получателя в отчёте нет) и как его назвать. */
interface SnapshotShare {
  owed: bigint | null;
  label: string;
}

function shareOf(payee: Payee, snapshot: PeriodSnapshot, names: ReadonlyMap<string, string>): SnapshotShare {
  switch (payee.kind) {
    case "stakeholder": {
      const owed = BigInt(snapshot.rub.payouts.find((payout) => payout.accountId === payee.accountId)?.rubMinor ?? "0");
      return { owed: owed > 0n ? owed : null, label: snapshot.accounts[payee.accountId] ?? names.get(payee.accountId) ?? payee.accountId };
    }
    case "tax": {
      const owed = BigInt(snapshot.rub.taxMinor);
      return { owed: owed > 0n ? owed : null, label: "Налог НПД" };
    }
    case "loan": {
      const loan = snapshot.loans.find((entry) => entry.loanId === payee.loanId);
      const owed = BigInt(loan?.trancheMinor ?? "0");
      return { owed: owed > 0n ? owed : null, label: loan?.lender ?? payee.loanId };
    }
    case "owner":
      // у владельца предела нет: его доля в отчёте — доллары, а платить можно в любой валюте места
      return { owed: BigInt(snapshot.rub.ownerUsdCents) > 0n ? 0n : null, label: "Владелец" };
  }
}

/** Месяц, которого нет или который не закрыт: платить за него нельзя, а факты нужны, чтобы сказать почему. */
function unsettled(base: Pick<PayoutFacts, "now" | "confirmDays">, status: PayoutFacts["periodStatus"], label: string): PayoutFacts {
  return { ...base, periodStatus: status, closedAt: null, inReport: false, owed: null, currency: null, debtAccountId: null, debtBalance: 0n, paid: 0n, confirmation: null, label };
}

/**
 * Факты для выплаты `input` на момент `now`. Получатель не разобран или месяц не закрыт — факты «платить нельзя»:
 * сборщик назовёт причину сам. `operationId` — сама операция: если её проводка уже в журнале (сбой до отметки «проведена»),
 * повтор не должен считать её выплаченной дважды и упереться в остаток.
 */
export async function loadPayoutFacts(repository: PayoutsRepository, settings: SettingsReader, input: OperationInputOf<"payout">, now: Date, operationId?: string): Promise<PayoutFacts> {
  const base = { now, confirmDays: settings.get(SETTINGS.financeConfirmDays) };
  const payee = parsePayee(input.payee);
  const row = await db(repository.period(input.period));
  if (payee === null) return unsettled(base, row?.status ?? "open", input.payee);
  if (row === null || row.status !== "closed" || row.closedAt === null || row.snapshot === null) return unsettled(base, row?.status ?? "open", input.payee);

  const snapshot = parseSnapshot(row.snapshot);
  const everything = await db(repository.payoutsOf(input.period));
  // Проводка самой операции, уже лежащая в журнале, — не «выплачено ранее»: повтор той же проводки её не удвоит.
  const records = everything.filter((record) => record.operationId !== operationId);
  const own = everything.filter((record) => record.operationId === operationId);
  /** Сальдо счёта без вклада самой операции: её собственная строка в журнале сальдо уже уменьшила. */
  const balanceOf = async (accountId: string): Promise<bigint> => (await db(repository.debtBalance(accountId))) + sumOnAccount(own, accountId);
  const names = payee.kind === "stakeholder" ? await db(repository.names([payee.accountId])) : new Map<string, string>();
  const share = shareOf(payee, snapshot, names);
  const common = { ...base, periodStatus: row.status, closedAt: row.closedAt, inReport: share.owed !== null, label: share.label };

  switch (payee.kind) {
    case "stakeholder": {
      const debtAccountId = stakeholderDebtAccount(payee.accountId);
      return {
        ...common,
        owed: share.owed,
        currency: "RUB",
        debtAccountId,
        debtBalance: await balanceOf(debtAccountId),
        paid: sumOf(records, input.payee),
        confirmation: await db(repository.confirmation(input.period, payee.accountId)),
      };
    }
    case "tax":
      return { ...common, owed: share.owed, currency: "RUB", debtAccountId: TAX_DEBT_ACCOUNT, debtBalance: await balanceOf(TAX_DEBT_ACCOUNT), paid: sumOf(records, "tax"), confirmation: null };
    case "loan": {
      const loan = await db(repository.loan(payee.loanId));
      const snapshotLoan = snapshot.loans.find((entry) => entry.loanId === payee.loanId);
      return {
        ...common,
        // займа нет в базе — платить некуда: без счёта обязательства сборщик откажет
        inReport: common.inReport && loan !== null,
        owed: share.owed,
        currency: loan?.currency ?? snapshotLoan?.currency ?? null,
        debtAccountId: loan?.accountId ?? null,
        debtBalance: loan === null ? 0n : await balanceOf(loan.accountId),
        paid: sumOf(records, input.payee),
        confirmation: null,
      };
    }
    case "owner":
      // `owed` у владельца — только отметка «есть что делить»: предела по сумме нет, поэтому наружу `null`
      return { ...common, owed: null, currency: null, debtAccountId: null, debtBalance: 0n, paid: 0n, confirmation: null };
  }
}
