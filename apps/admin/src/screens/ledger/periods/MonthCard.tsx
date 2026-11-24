import { useState, type ReactNode } from "react";
import { closePeriod, loadPayouts, loadPeriod, PERIOD_STATUS_LABELS, periodTone, reopenPeriod, startReview, type PeriodListItem } from "../../../api/ledger-periods";
import { api } from "../../../services";
import { ConfirmDialog } from "../../../ui/confirm-dialog";
import { Badge, ErrorNotice, Loading, Notice } from "../../../ui/kit";
import { toast } from "../../../ui/toast";
import { useApi } from "../../../ui/use-api";
import { ChecklistView } from "./ChecklistView";
import { closeConsequence, formatUsd, monthTitle, type PayoutTarget } from "./model";
import { ParticipantsView } from "./ParticipantsView";
import { PayoutDialog } from "./PayoutDialog";
import { PeriodActions } from "./PeriodActions";
import { ReportBody } from "./ReportBody";

/**
 * Месяц учёта на вкладке «Месяцы» (tasks/T-0470, Р222): строка со статусом и суммой к разделу, а раскрытая —
 * чек-лист сверки, отчёт по docs/11 §5, действия владельца и, у закрытого месяца, участники с выплатами. Данные
 * месяца грузятся, только когда он не «открыт» или раскрыт: сумма к разделу в строке — из того же отчёта сервера.
 */
export function MonthCard({
  item,
  expanded,
  canClose,
  canPay,
  onToggle,
  onChanged,
}: {
  item: PeriodListItem;
  expanded: boolean;
  canClose: boolean;
  canPay: boolean;
  onToggle: () => void;
  onChanged: () => void;
}): ReactNode {
  const { period, status } = item;
  const enabled = status !== "open" || expanded;
  const month = useApi(() => (enabled ? loadPeriod(api, period) : Promise.resolve({ ok: true as const, data: null })), [period, status, enabled]);
  const payouts = useApi(() => (status === "closed" && expanded ? loadPayouts(api, period) : Promise.resolve({ ok: true as const, data: null })), [period, status, expanded]);

  const [now] = useState(() => new Date());
  const [asking, setAsking] = useState<"close" | "reopen" | null>(null);
  const [paying, setPaying] = useState<PayoutTarget | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = (): void => {
    month.reload();
    payouts.reload();
    onChanged();
  };

  const review = (): void => {
    setActionError(null);
    void startReview(api, period).then((result) => {
      if (!result.ok) return setActionError(result.error.message);
      toast.success(`${monthTitle(period)} поставлен на сверку`);
      refresh();
    });
  };

  const view = month.state.status === "ok" ? month.state.data : null;
  const report = view?.report ?? null;
  const share = report === null ? null : report.toDistribute;
  const payoutView = payouts.state.status === "ok" ? payouts.state.data : null;

  return (
    <li className="rounded-md border border-border bg-surface">
      <button type="button" aria-expanded={expanded} onClick={onToggle} className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{monthTitle(period)}</span>
          <Badge tone={periodTone(status)}>{PERIOD_STATUS_LABELS[status]}</Badge>
          {item.reopenedCount > 0 ? <span className="text-xs text-text-muted">{`закрытие снималось: ${String(item.reopenedCount)}`}</span> : null}
        </span>
        <span className="text-sm tabular-nums text-text-muted">{share === null ? (status === "open" ? "" : "—") : `К разделу ${formatUsd(share)}`}</span>
      </button>

      {expanded ? (
        <div className="flex flex-col gap-4 border-t border-border p-4">
          {month.state.status === "loading" ? <Loading /> : null}
          {month.state.status === "error" ? <ErrorNotice error={month.state.error} onRetry={month.reload} /> : null}
          {view === null ? null : (
            <>
              <PeriodActions view={view} payouts={payoutView} now={now} canClose={canClose} onReview={review} onClose={() => setAsking("close")} onReopen={() => setAsking("reopen")} />
              {actionError === null ? null : <Notice>{actionError}</Notice>}
              {status === "open" ? <p className="text-sm text-text-muted">Месяц открыт: цифры ниже — как вышло бы на сегодня. Закрыть его можно после сверки.</p> : null}
              {status === "closed" && view.checklist.length === 0 ? null : <ChecklistView items={view.checklist} />}
              {view.report === null ? <Notice tone="warning">Отчёт не посчитан: нет курса на дату проводки месяца — он появится, когда курс будет.</Notice> : <ReportBody report={view.report} isDraft={view.reportIsDraft} />}
              {status === "closed" ? (
                <section className="flex flex-col gap-2 border-t border-border pt-4">
                  <h3 className="text-sm font-semibold">Участники и выплаты</h3>
                  {payouts.state.status === "loading" ? <Loading /> : null}
                  {payouts.state.status === "error" ? <ErrorNotice error={payouts.state.error} onRetry={payouts.reload} /> : null}
                  {payoutView === null ? null : <ParticipantsView status={payoutView} canPay={canPay} now={now} onPay={setPaying} />}
                </section>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {report === null ? null : (
        <ConfirmDialog
          open={asking === "close"}
          onOpenChange={(open) => (open ? undefined : setAsking(null))}
          title={`Закрыть ${monthTitle(period).toLowerCase()}?`}
          subject="Закрытие запишет начисления и снимок отчёта"
          action="Закрыть месяц"
          onConfirm={async () => {
            const result = await closePeriod(api, period);
            if (!result.ok) return { ok: false, error: result.error.message };
            toast.success(`${monthTitle(period)} закрыт`);
            refresh();
            return { ok: true };
          }}
        >
          <p className="text-sm">{closeConsequence(period, report)}</p>
        </ConfirmDialog>
      )}

      <ConfirmDialog
        open={asking === "reopen"}
        onOpenChange={(open) => (open ? undefined : setAsking(null))}
        title={`Снять закрытие: ${monthTitle(period).toLowerCase()}?`}
        subject="Возможно, пока никому не выплачено"
        changes={[{ label: "Что будет", value: "начисления сторнируются, подтверждения сбросятся, участникам придёт сообщение" }]}
        reason={{ min: 3, max: 500, label: "Причина снятия закрытия", hint: "Попадёт в аудит и в сообщение участникам" }}
        action="Снять закрытие"
        tone="danger"
        onConfirm={async (reason) => {
          const result = await reopenPeriod(api, period, reason);
          if (!result.ok) return { ok: false, error: result.error.message };
          toast.success(`Закрытие ${monthTitle(period).toLowerCase()} снято`);
          refresh();
          return { ok: true };
        }}
      />

      {paying === null ? null : (
        <PayoutDialog
          period={period}
          target={paying}
          onClose={() => setPaying(null)}
          onDone={() => {
            setPaying(null);
            refresh();
          }}
        />
      )}
    </li>
  );
}
