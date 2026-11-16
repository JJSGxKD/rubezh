import { useState, type ReactNode } from "react";
import type { ApiError } from "../../api/client";
import { DISPUTE_MAX, disputeProblem, moneyLine, monthTitle, reportStatus, type MyDecision, type MyReport, type ReportStatus } from "../../api/my-project";
import { Button, ErrorNotice, Notice, Panel, TextArea } from "../../ui/kit";

/**
 * Отчёт закрытого месяца в кабинете участника (docs/29-admin-panel.md §6.6, Р222, docs/11-revenue-split.md §5) и его
 * подтверждение. Все суммы — строки из ответа сервера (снимок закрытия): панель их не считает и не округляет, иначе
 * отчёт участника разошёлся бы с тем, что владелец платит. Участник видит только свой отчёт — маршрут сервера отдаёт
 * его строку и общий водопад месяца.
 */

const PAYER_TITLES = { individual: "Физические лица", legal: "Юридические лица" } as const;

/** «6.00» → «6,00 %»: ставка приходит строкой с точкой. */
const percent = (value: string): string => `${value.replace(".", ",")} %`;

const usd = (amount: string): string => moneyLine(amount, "$");
const rub = (amount: string): string => moneyLine(amount, "₽");

function Row({ label, value, strong = false, muted = false }: { label: ReactNode; value: ReactNode; strong?: boolean; muted?: boolean }) {
  return (
    <li className={`flex flex-wrap justify-between gap-x-3 gap-y-0.5 ${strong ? "border-t border-border pt-1 font-semibold" : ""} ${muted ? "text-text-muted" : ""}`}>
      <span className="min-w-0">{label}</span>
      <span className="tabular-nums">{value}</span>
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-semibold uppercase text-text-muted">{title}</h3>
      <ul className="flex flex-col gap-1 text-sm">{children}</ul>
    </div>
  );
}

const STATUS_TONES = { waiting: "warning", confirmed: "info", disputed: "danger", paid: "success" } as const;

function statusText(report: MyReport, status: ReportStatus): string {
  const { mine } = report;
  if (status === "waiting") return "Ждёт твоего подтверждения";
  if (status === "confirmed") return "Ты подтвердил";
  if (status === "disputed") {
    const comment = mine.confirmation?.comment?.trim() ?? "";
    return comment === "" ? "Ты оспорил" : `Ты оспорил: ${comment}`;
  }
  const rest = Number(mine.remainingRub) > 0 ? `, осталось ${rub(mine.remainingRub)}` : "";
  return `Выплачено ${rub(mine.paidRub)}${rest}`;
}

function StatusBlock({ report }: { report: MyReport }) {
  const status = reportStatus(report);
  const mineUsd = report.report.payouts.find((payout) => payout.accountId === report.mine.accountId)?.usd ?? null;
  return (
    <Panel title="Моя часть">
      <div className="flex flex-col gap-3">
        <Notice tone={STATUS_TONES[status]}>{statusText(report, status)}</Notice>
        <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 tabular-nums">
          <b className="text-2xl">{rub(report.mine.owedRub)}</b>
          {mineUsd === null ? null : <span className="text-text-muted">{usd(mineUsd)}</span>}
        </p>
      </div>
    </Panel>
  );
}

function IncomeBlock({ report }: { report: MyReport["report"] }) {
  return (
    <Section title="Доходы">
      {[...report.revenue, ...report.otherIncome].map((line) => (
        <Row key={line.key} label={line.name} value={usd(line.amount)} />
      ))}
      <Row label="Выручка всего" value={usd(report.grossRevenue)} strong />
    </Section>
  );
}

function ExpensesBlock({ report }: { report: MyReport["report"] }) {
  return (
    <Section title="Расходы">
      {report.expenses.map((line) => (
        <Row key={line.key} label={line.name} value={usd(line.amount)} />
      ))}
      <Row label="Расходы всего" value={usd(report.totalExpenses)} strong />
      <Row label="Прибыль до налога" value={usd(report.profitBeforeTax)} strong />
    </Section>
  );
}

function TaxBlock({ report }: { report: MyReport["report"] }) {
  const { tax } = report;
  if (tax.byPayer.length === 0 && Number(tax.usd) === 0) return null;
  return (
    <Section title="Налог">
      {tax.byPayer.map((line) => (
        <Row
          key={line.payer}
          label={
            <>
              {PAYER_TITLES[line.payer]} <span className="text-text-muted">· поступления {rub(line.receiptsRub)}, ставка {percent(line.ratePercent)}</span>
            </>
          }
          value={rub(line.taxRub)}
        />
      ))}
      <Row label="Налог всего" value={`${rub(tax.rub)} · ${usd(tax.usd)}`} strong />
      <Row label="Чистая прибыль" value={usd(report.netProfit)} strong />
    </Section>
  );
}

function LoansBlock({ report }: { report: MyReport["report"] }) {
  if (report.tranches.length === 0) return null;
  return (
    <Section title="Займ">
      {report.tranches.map((tranche) => (
        <Row
          key={tranche.loanId}
          label={
            <>
              {tranche.lender} <span className="text-text-muted">· осталось после транша {usd(tranche.remainingAfterUsd)}</span>
            </>
          }
          value={`${usd(tranche.usd)} · ${moneyLine(tranche.inLoanCurrency, tranche.currency)}`}
        />
      ))}
    </Section>
  );
}

function SplitBlock({ report, mineId }: { report: MyReport["report"]; mineId: string }) {
  return (
    <Section title="Раздел прибыли">
      {report.noDistribution ? <li className="text-text-muted">Делить в этом месяце было нечего</li> : null}
      <Row label="К разделу" value={usd(report.toDistribute)} strong />
      {report.payouts.map((payout) => (
        <Row
          key={payout.accountId}
          label={
            <>
              {payout.name}
              {payout.accountId === mineId ? " · вы" : ""} <span className="text-text-muted">· {percent(payout.percent)}</span>
            </>
          }
          value={`${usd(payout.usd)} · ${rub(payout.rub)}`}
        />
      ))}
      <Row label="Остаток владельца" value={usd(report.ownerAmount)} strong />
    </Section>
  );
}

function ReportBlock({ data }: { data: MyReport }) {
  const { report } = data;
  return (
    <Panel title={`Отчёт за ${monthTitle(data.period)}`}>
      <div className="flex flex-col gap-5">
        <IncomeBlock report={report} />
        <ExpensesBlock report={report} />
        <TaxBlock report={report} />
        <LoansBlock report={report} />
        <SplitBlock report={report} mineId={data.mine.accountId} />
        {report.rubRate === null ? null : <p className="text-xs text-text-muted tabular-nums">Курс закрытия: 1 ₽ = {report.rubRate.replace(".", ",")} $</p>}
      </div>
    </Panel>
  );
}

interface DecisionProps {
  report: MyReport;
  busy: boolean;
  error: ApiError | null;
  initialDisputing: boolean;
  onDecide: (decision: MyDecision, comment?: string) => void;
}

/** Кнопки решения: пока не выплачено — можно подтвердить или оспорить, и поменять решение; после выплаты их нет. */
function Decision({ report, busy, error, initialDisputing, onDecide }: DecisionProps) {
  const { mine } = report;
  const [changing, setChanging] = useState(initialDisputing);
  const [disputing, setDisputing] = useState(initialDisputing);
  const [comment, setComment] = useState(mine.confirmation?.status === "disputed" ? (mine.confirmation.comment ?? "") : "");
  const [touched, setTouched] = useState(false);

  if (!mine.canChange) return error === null ? null : <ErrorNotice error={error} />;

  const decided = mine.confirmation !== null;
  const problem = disputeProblem(comment);
  const showButtons = !decided || changing;

  return (
    <div className="flex flex-col gap-3">
      {error === null ? null : <ErrorNotice error={error} />}
      {showButtons ? (
        <div className="flex flex-wrap gap-2">
          <Button tone="primary" disabled={busy} onClick={() => onDecide("confirmed")}>
            Подтверждаю
          </Button>
          <Button disabled={busy} onClick={() => setDisputing(true)}>
            Есть вопрос
          </Button>
        </div>
      ) : (
        <div>
          <Button onClick={() => setChanging(true)}>Изменить решение</Button>
        </div>
      )}
      {showButtons && disputing ? (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Что не сходится</span>
            <TextArea rows={4} maxLength={DISPUTE_MAX} value={comment} onChange={(event) => setComment(event.target.value)} onBlur={() => setTouched(true)} placeholder="Например: не понимаю строку расходов на серверы" />
          </label>
          {touched && problem !== null ? <p className="text-xs text-danger">{problem}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button tone="primary" disabled={busy || problem !== null} onClick={() => onDecide("disputed", comment)}>
              Отправить вопрос
            </Button>
            <Button disabled={busy} onClick={() => setDisputing(false)}>
              Отмена
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Закрытый месяц вместо черновика: статус и моя часть, решение, отчёт. Запросы — у вызывающего. */
export function ClosedMonth({ report, busy, error, onDecide, initialDisputing = false }: { report: MyReport; busy: boolean; error: ApiError | null; onDecide: DecisionProps["onDecide"]; initialDisputing?: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <StatusBlock report={report} />
      <Decision report={report} busy={busy} error={error} initialDisputing={initialDisputing} onDecide={onDecide} />
      <ReportBlock data={report} />
    </div>
  );
}
