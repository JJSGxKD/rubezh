import { useState, type FormEvent } from "react";
import { api } from "../../services";
import { fetchFunnel, FUNNEL_STEPS, funnelTotal, periodFromDates, platformTitle, shareOfAccounts, touchOf, type FunnelRow, type Period } from "../../api/funnel";
import { formatDateTime, formatNumber } from "../../format";
import { Button, DataTable, ErrorNotice, Field, Input, Loading, Panel, type Column } from "../../ui/kit";
import { HELP } from "../../ui/help";
import { useApi } from "../../ui/use-api";

/**
 * Воронка по источникам. Число и доля от аккаунтов строки в одной ячейке:
 * абсолют без доли не сравнить между источниками, доля без абсолюта врёт на
 * малых числах (docs/29-admin-panel.md §5.2).
 */
export function FunnelScreen() {
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [period, setPeriod] = useState<Period>({});
  const { state, reload } = useApi(() => fetchFunnel(api, period), [period.from, period.to]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setPeriod(periodFromDates(fromDate, toDate));
  };

  const cell = (row: FunnelRow, step: (typeof FUNNEL_STEPS)[number][0]) => {
    const share = shareOfAccounts(row, step);
    return (
      <span className="whitespace-nowrap">
        {formatNumber(row[step])}
        {share === null ? null : <span className="ml-1 text-xs text-text-muted">{share}%</span>}
      </span>
    );
  };

  const columns: Column<FunnelRow>[] = [
    { title: "Площадка", render: (row) => platformTitle(row.platform) },
    { title: "Откуда пришли", help: HELP.funnel.touch, render: (row) => <TouchCell row={row} /> },
    { title: "Аккаунтов", render: (row) => formatNumber(row.accounts), align: "right" },
    ...FUNNEL_STEPS.map(
      ([step, title]): Column<FunnelRow> => ({
        title,
        render: (row) => cell(row, step),
        align: "right",
        ...(step === "returnedD1" || step === "returnedD7" ? { help: HELP.funnel.returned } : {}),
      }),
    ),
  ];

  return (
    <Panel title="Воронка по источникам" help={HELP.funnel.funnel} actions={<Button onClick={reload}>Обновить</Button>}>
      <form onSubmit={submit} className="mb-4 flex items-end gap-2">
        <Field label="С">
          <Input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
        </Field>
        <Field label="По (включительно)">
          <Input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
        </Field>
        <Button tone="primary" type="submit">
          Показать
        </Button>
        <span className="pb-2 text-xs text-text-muted">Пусто — последние тридцать дней; не длиннее года.</span>
      </form>
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok" ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-text-muted">
            Период: {formatDateTime(state.data.from)} — {formatDateTime(state.data.to)}. Доля — от аккаунтов той же строки.
          </p>
          <DataTable
            rows={state.data.rows.length === 0 ? [] : [funnelTotal(state.data.rows), ...state.data.rows]}
            rowKey={(row) => `${row.platform}|${row.startKind}|${row.startRef ?? ""}|${row.startSource ?? ""}`}
            empty="За период никто не пришёл"
            columns={columns}
          />
        </div>
      ) : null}
    </Panel>
  );
}

function TouchCell({ row }: { row: FunnelRow }) {
  const touch = touchOf(row);
  return (
    <span className="flex max-w-72 flex-col">
      <span className={row.startKind === "все" ? "font-medium" : ""}>{touch.title}</span>
      {touch.detail === null ? null : <span className="text-xs text-text-muted">{touch.detail}</span>}
    </span>
  );
}
