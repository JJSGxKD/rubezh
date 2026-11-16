import type { ReactNode } from "react";
import type { ReportLine, ReportView } from "../../../api/ledger-periods";
import { Badge } from "../../../ui/kit";
import { formatRub, formatUsd } from "./model";

/**
 * Отчёт месяца по docs/11-revenue-split.md §5 (tasks/T-0470): платежи, реклама, расходы, налог, заём, прибыль к
 * разделу и доли — шесть обязательных разделов. Суммы — из ответа сервера: у закрытого месяца это снимок закрытия, у
 * месяца на сверке — черновик «как вышло бы сегодня».
 */

const PAYER_LABELS = { individual: "физлица", legal: "юрлица" } as const;

/** «4.00» → «4», «12.50» → «12,50»: хвост из нулей отбрасывается, точка — запятая. */
function percentText(value: string): string {
  return value.replace(/\.0+$/u, "").replace(".", ",");
}

function Row({ label, value, strong = false, muted = false }: { label: ReactNode; value: ReactNode; strong?: boolean; muted?: boolean }): ReactNode {
  return (
    <div className={`flex items-baseline justify-between gap-3 py-0.5 text-sm ${strong ? "font-semibold" : ""} ${muted ? "text-text-muted" : ""}`}>
      <dt className="min-w-0 break-words">{label}</dt>
      <dd className="shrink-0 text-right tabular-nums">{value}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="flex flex-col gap-1 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold">{title}</h3>
      <dl className="flex flex-col">{children}</dl>
    </section>
  );
}

function Lines({ lines, empty }: { lines: readonly ReportLine[]; empty: string }): ReactNode {
  if (lines.length === 0) return <p className="text-sm text-text-muted">{empty}</p>;
  return (
    <>
      {lines.map((line) => (
        <Row key={line.key} label={line.name} value={formatUsd(line.amount)} />
      ))}
    </>
  );
}

export function ReportBody({ report, isDraft }: { report: ReportView; isDraft: boolean }): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
        {isDraft ? <Badge tone="warning">Черновик — посчитан сейчас, не закрыт</Badge> : null}
        <span>{`Суммы в долларах и рублях${report.rubRate === null ? "" : `; цена рубля — $${report.rubRate}`}`}</span>
      </div>

      <Section title="Доход с платежей">
        <Lines lines={report.revenue} empty="Платежей в месяце не было" />
      </Section>

      <Section title="Доход с рекламы и прочие поступления">
        <Lines lines={report.otherIncome} empty="Поступлений в месяце не было" />
        <Row label="Валовый доход" value={formatUsd(report.grossRevenue)} strong />
      </Section>

      <Section title="Операционные расходы">
        <Lines lines={report.expenses} empty="Расходов в месяце не было" />
        <Row label="Расходы всего" value={formatUsd(report.totalExpenses)} strong />
        <Row label="Прибыль до налога" value={formatUsd(report.profitBeforeTax)} muted />
      </Section>

      <Section title="Налог">
        <Row label="Режим" value="НПД" muted />
        {report.tax.byPayer.length === 0 ? <p className="text-sm text-text-muted">Чеков в месяце не было</p> : null}
        {report.tax.byPayer.map((line) => (
          <Row key={line.payer} label={`${PAYER_LABELS[line.payer]} ${percentText(line.ratePercent)} % от ${formatRub(line.receiptsRub)}`} value={formatRub(line.taxRub)} />
        ))}
        <Row label="Налог за месяц" value={`${formatRub(report.tax.rub)} · ${formatUsd(report.tax.usd)}`} strong />
        <Row label="Чистая прибыль" value={formatUsd(report.netProfit)} muted />
      </Section>

      <Section title="Заём">
        {report.tranches.length === 0 ? <p className="text-sm text-text-muted">Траншей в этом месяце нет</p> : null}
        {report.tranches.map((tranche) => (
          <div key={tranche.loanId} className="flex flex-col">
            <Row label={tranche.lender} value={`транш ${formatUsd(tranche.usd)}`} />
            <Row label="в валюте займа" value={`${tranche.inLoanCurrency} ${tranche.currency}`} muted />
            <Row label="осталось после транша" value={formatUsd(tranche.remainingAfterUsd)} muted />
          </div>
        ))}
      </Section>

      <Section title="К разделу и доли">
        <Row label="Прибыль к разделу" value={formatUsd(report.toDistribute)} strong />
        {report.noDistribution || report.payouts.length === 0 ? <p className="text-sm text-text-muted">Делить нечего: выплат участникам нет</p> : null}
        {report.payouts.map((payout) => (
          <Row key={payout.accountId} label={`${payout.name} · ${percentText(payout.percent)} %`} value={`${formatUsd(payout.usd)} · ${formatRub(payout.rub)}`} />
        ))}
        <Row label="Остаток владельца" value={formatUsd(report.ownerAmount)} strong />
      </Section>
    </div>
  );
}
