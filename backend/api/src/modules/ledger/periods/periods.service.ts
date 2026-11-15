import { Inject, Injectable } from "@nestjs/common";
import { isCurrencyCode } from "@bh/fx";
import { periodOf } from "@bh/ledger";
import { ValidationError } from "../../../common/domain-error.js";
import { withTimeout } from "../../../common/with-timeout.js";
import { FxService } from "../../fx/fx.service.js";
import type { RateQuery } from "../../fx/fx-history.js";
import type { AccountRef } from "../../roles/roles.service.js";
import { RolesService } from "../../roles/roles.service.js";
import { SETTINGS } from "../../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../../settings/settings.service.js";
import { buildChecklist, hasBlockers, type ChecklistItem } from "./checklist.js";
import { closeEntries, computeClose, type CloseLoan, type CloseResult, type PeriodSettings } from "./period-close.js";
import { LedgerPeriodBlockedError, LedgerPeriodChangedError, LedgerPeriodHasPayoutsError, LedgerPeriodNotEndedError, LedgerPeriodStatusError } from "./period-errors.js";
import { dayOf, rateKey, rateQueries, valueLines, type DatedRate } from "./period-facts.js";
import { PERIOD_HOOKS, type PeriodHooks } from "./period-hooks.js";
import { isEnded, isPeriod, type PeriodStatus } from "./period-rules.js";
import { parseSnapshot } from "./period-snapshot.js";
import { PERIODS_REPOSITORY, type MonthSource, type PeriodsRepository } from "./period-types.js";
import { listItemOf, reportOf, type PeriodListItem, type PeriodReportView } from "./period-view.js";

/**
 * Месяцы учёта (docs/37-accounting.md §13, Р222, tasks/T-0468): сверка с блокерами, закрытие с водопадом и снятие
 * закрытия. Права проверяет охранник маршрута (`finance.period.close` — только владелец; чтение — `ledger.view`);
 * здесь — правила состояний, расчёт и аудит каждого действия. Что и как записывается в базу одной транзакцией —
 * репозиторий; что считается — чистые функции этого каталога.
 */

export type PeriodActor = AccountRef;

const RATES_TIMEOUT_MS = 15_000;
const DB_TIMEOUT_MS = 10_000;
/** Транзакция закрытия длиннее обычного запроса: проводки, счета и снимок. Репозиторий ограничивает её своим потолком. */
const COMMIT_TIMEOUT_MS = 40_000;

/** Список показывает не дальше этого числа месяцев назад: бесконечная лента пустых месяцев не нужна. */
const LIST_MONTHS = 120;

const REASON_MIN = 3;
const REASON_MAX = 500;

const MAX_SHARE_SUM_BP = 10_000;

/** Всё, что нашлось и посчитано по месяцу: источник из базы, чек-лист и, если считать есть из чего, итог. */
interface Evaluation {
  source: MonthSource;
  checklist: ChecklistItem[];
  result: CloseResult | null;
}

function previousPeriod(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 2, 1);
  return periodOf(date);
}

@Injectable()
export class PeriodsService {
  constructor(
    @Inject(PERIODS_REPOSITORY) private readonly repository: PeriodsRepository,
    private readonly fx: FxService,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    private readonly roles: RolesService,
    @Inject(PERIOD_HOOKS) private readonly hooks: PeriodHooks,
  ) {}

  /** Месяцы от текущего назад до первой проводки (но не глубже `LIST_MONTHS`) и строки, которые есть в базе; новые сверху. */
  async list(now: Date = new Date()): Promise<PeriodListItem[]> {
    const [first, rows] = await Promise.all([this.db(this.repository.firstEntryPeriod()), this.db(this.repository.rows())]);
    const byPeriod = new Map(rows.map((row) => [row.period, row]));
    const current = periodOf(now);
    const periods = new Set<string>([current, ...byPeriod.keys()]);
    if (first !== null) {
      let walk = current;
      for (let step = 0; step < LIST_MONTHS && walk > first; step += 1) {
        walk = previousPeriod(walk);
        periods.add(walk);
      }
    }
    return [...periods]
      .sort((a, b) => b.localeCompare(a))
      .map((period) => {
        const row = byPeriod.get(period);
        return row === undefined ? { period, status: "open" as const, reopenedCount: 0, reviewAt: null, closedAt: null } : listItemOf(row);
      });
  }

  /**
   * Отчёт месяца: чек-лист и итог. Закрытый месяц — из снимка (что поменяли после закрытия, на него не влияет);
   * остальные — черновик, посчитанный сейчас по текущим курсам и дню закрытия «сегодня».
   */
  async report(period: string, now: Date = new Date()): Promise<PeriodReportView> {
    assertPeriod(period);
    const row = await this.db(this.repository.row(period));
    const status: PeriodStatus = row?.status ?? "open";
    const head = {
      period,
      status,
      reopenedCount: row?.reopenedCount ?? 0,
      reviewAt: row?.reviewAt?.toISOString() ?? null,
      closedAt: row?.closedAt?.toISOString() ?? null,
    };
    if (status === "closed" && row !== null && row.snapshot !== null) {
      const snapshot = parseSnapshot(row.snapshot);
      return { ...head, checklist: snapshot.warnings, canClose: false, reportIsDraft: false, report: reportOf(snapshot) };
    }
    const evaluation = await this.evaluate(period, row?.reopenedCount ?? 0, now);
    return {
      ...head,
      checklist: evaluation.checklist,
      canClose: status === "review" && evaluation.result !== null && !hasBlockers(evaluation.checklist),
      reportIsDraft: true,
      report: evaluation.result === null ? null : reportOf(evaluation.result.snapshot),
    };
  }

  /** `open → review`: только кончившийся месяц. Повтор безопасен — второго аудита нет; закрытый месяц на сверку не идёт. */
  async startReview(actor: PeriodActor, period: string, now: Date = new Date()): Promise<void> {
    assertPeriod(period);
    if (!isEnded(period, now)) throw new LedgerPeriodNotEndedError(period);
    const outcome = await this.db(this.repository.startReview(period, actor.accountId, now));
    if (outcome === "closed") throw new LedgerPeriodStatusError(period, "closed", "open");
    if (outcome === "started") await this.roles.audit({ actorAccountId: actor.accountId, action: "ledger.period.review", target: period, after: { period } });
  }

  /**
   * Закрыть месяц: блокеров нет — считается всё заново (между сверкой и закрытием в месяце могли появиться
   * проводки), и снимок, проводки закрытия и статус пишутся одной транзакцией. Из двух одновременных закрытий
   * проходит одно; если пока считалось, журнал месяца изменился, — отказ с просьбой повторить.
   */
  async close(actor: PeriodActor, period: string, now: Date = new Date()): Promise<void> {
    assertPeriod(period);
    const row = await this.db(this.repository.row(period));
    const status: PeriodStatus = row?.status ?? "open";
    if (row === null || status !== "review") throw new LedgerPeriodStatusError(period, status, "review");

    const evaluation = await this.evaluate(period, row.reopenedCount, now);
    if (hasBlockers(evaluation.checklist)) throw new LedgerPeriodBlockedError(period, evaluation.checklist.filter((item) => item.severity === "blocker"));
    if (evaluation.result === null) throw new Error(`Месяц ${period}: блокеров нет, а итог не посчитан`);

    const { accounts, entries } = closeEntries(evaluation.result);
    const outcome = await withTimeout(
      this.repository.commitClose({ period, round: row.reopenedCount, closedAt: now, closedBy: actor.accountId, fingerprint: evaluation.source.fingerprint, snapshot: evaluation.result.snapshot, accounts, entries }),
      COMMIT_TIMEOUT_MS,
      "закрытие месяца",
    );
    if (outcome.outcome === "not_review") throw new LedgerPeriodStatusError(period, outcome.status, "review");
    if (outcome.outcome === "changed") throw new LedgerPeriodChangedError(period);

    const { snapshot } = evaluation.result;
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "ledger.period.close",
      target: period,
      after: { period, round: row.reopenedCount, netProfitUsdCents: snapshot.waterfall.netProfit, taxRubMinor: snapshot.rub.taxMinor, payouts: snapshot.rub.payouts.length, entries: snapshot.entries },
    });
  }

  /**
   * Снять закрытие: причина обязательна; по месяцу не должно быть выплат (хук T-0469). Проводки закрытия этого раза
   * сторнируются, месяц возвращается на сверку, а подтверждения участников сбрасываются.
   */
  async reopen(actor: PeriodActor, period: string, reason: string, now: Date = new Date()): Promise<void> {
    assertPeriod(period);
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) throw new ValidationError(`Причина снятия закрытия — от ${String(REASON_MIN)} до ${String(REASON_MAX)} знаков`);
    const row = await this.db(this.repository.row(period));
    const status: PeriodStatus = row?.status ?? "open";
    if (row === null || status !== "closed") throw new LedgerPeriodStatusError(period, status, "closed");
    if (await this.db(this.hooks.hasPayouts(period))) throw new LedgerPeriodHasPayoutsError(period);

    const outcome = await withTimeout(this.repository.commitReopen({ period, round: row.reopenedCount, at: now, by: actor.accountId, reason: trimmed }), COMMIT_TIMEOUT_MS, "снятие закрытия месяца");
    if (outcome.outcome === "not_closed") throw new LedgerPeriodStatusError(period, outcome.status, "closed");
    if (outcome.outcome === "changed") throw new LedgerPeriodChangedError(period);

    await this.db(this.hooks.resetConfirmations(period));
    await this.roles.audit({ actorAccountId: actor.accountId, action: "ledger.period.reopen", target: period, after: { period, round: row.reopenedCount, reason: trimmed, reversed: outcome.reversed } });
  }

  private periodSettings(): PeriodSettings {
    return {
      npdRateIndividualBp: this.settings.get(SETTINGS.financeNpdRateIndividualBp),
      npdRateLegalBp: this.settings.get(SETTINGS.financeNpdRateLegalBp),
      npdYearLimitRub: this.settings.get(SETTINGS.financeNpdYearLimitRub),
      npdWarnPercent: this.settings.get(SETTINGS.financeNpdWarnPercent),
    };
  }

  /**
   * Всё, что нужно сверке и закрытию: месяц из базы, курсы одним пакетом (на момент каждой проводки; рубль и валюты
   * займов — на день закрытия, то есть на `now`), чек-лист и итог. Итога нет, пока не на что опереться: нет курса
   * на дату проводки или курса рубля на день закрытия — это блокеры, а не повод считать по нулю.
   */
  private async evaluate(period: string, round: number, now: Date): Promise<Evaluation> {
    const source = await this.db(this.repository.loadMonth(period));
    const settings = this.periodSettings();
    const shares = source.shares.filter((share) => share.bp > 0);
    const needRub = source.receipts.length > 0 || shares.length > 0;

    const loans = source.loans
      .map((loan) => ({ loan, remaining: loan.principalMinor + loan.premiumMinor - loan.repaidMinor }))
      .filter(({ remaining }) => remaining > 0n)
      .sort((a, b) => a.loan.takenAt.getTime() - b.loan.takenAt.getTime() || a.loan.loanId.localeCompare(b.loan.loanId));

    const extra: RateQuery[] = [];
    if (needRub) extra.push({ currency: "RUB", at: now });
    for (const { loan } of loans) if (isCurrencyCode(loan.currency)) extra.push({ currency: loan.currency, at: now });
    const queries = rateQueries(source.lines, extra);
    const answers = queries.length === 0 ? [] : await withTimeout(this.fx.ratesAt(queries), RATES_TIMEOUT_MS, "курсы валют");
    const lookup = new Map(queries.map((query, index) => [rateKey(query.currency, query.at), answers[index] ?? null] as const));

    const valuation = valueLines(source.lines, lookup);
    const missing = new Map<string, DatedRate>(valuation.missing.map((rate) => [`${rate.currency}|${rate.day}`, rate]));
    const stale = new Map<string, DatedRate>(valuation.stale.map((rate) => [`${rate.currency}|${rate.day}`, rate]));
    const today = dayOf(now);
    const dayRate = (currency: string) => {
      const rate = lookup.get(rateKey(currency, now)) ?? null;
      const key = `${currency}|${today}`;
      if (rate === null) missing.set(key, { currency, day: today });
      else if (rate.stale) stale.set(key, { currency, day: today });
      return rate;
    };
    const rubRate = needRub ? dayRate("RUB") : null;
    const closeLoans: CloseLoan[] = [];
    for (const { loan, remaining } of loans) {
      const rate = dayRate(loan.currency);
      if (rate !== null) closeLoans.push({ loanId: loan.loanId, lender: loan.lender, currency: loan.currency, remainingMinor: remaining, repaymentBp: loan.repaymentBp, usdPerUnit: rate.usdPerUnit.toFixed() });
    }

    const sharesOverLimit = source.shares.reduce((sum, share) => sum + share.bp, 0) > MAX_SHARE_SUM_BP;
    const byDay = (a: DatedRate, b: DatedRate) => (a.day === b.day ? a.currency.localeCompare(b.currency) : a.day.localeCompare(b.day));
    const checklist = buildChecklist({
      period,
      openOperations: source.openOperations,
      unpostedPurchaseIds: source.unpostedPurchaseIds,
      missingRates: [...missing.values()].sort(byDay),
      staleRates: [...stale.values()].sort(byDay),
      receiptsMissing: source.receiptsMissing.map((receipt) => ({ entryId: receipt.entryId, operationId: receipt.operationId })),
      npd: { yearReceiptsMinor: source.yearReceiptsMinor, limitRub: settings.npdYearLimitRub, warnPercent: settings.npdWarnPercent },
      sharesOverLimit,
    });

    if (missing.size > 0 || sharesOverLimit) return { source, checklist, result: null };
    const result = computeClose({
      period,
      round,
      closedAt: now,
      settings,
      buckets: valuation.buckets,
      receipts: source.receipts,
      rubRate: rubRate === null ? null : { usdPerUnit: rubRate.usdPerUnit.toFixed(), at: rubRate.at.toISOString(), stale: rubRate.stale },
      loans: closeLoans,
      shares,
      warnings: checklist.filter((item) => item.severity === "warning"),
    });
    return { source, checklist, result };
  }

  /** Запрос к базе с потолком ожидания: без него зависший запрос держал бы панель до таймаута соединения. */
  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "база учёта");
  }
}

function assertPeriod(period: string): void {
  if (!isPeriod(period)) throw new ValidationError("Месяц должен быть вида ГГГГ-ММ");
}
