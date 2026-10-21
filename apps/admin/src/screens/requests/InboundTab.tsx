import { MAX_CHART_BARS, fetchInbound, formatLatency, formatShare, groupSeries, seriesChart, serverErrorTone, type Inbound, type RequestPeriod } from "../../api/requests";
import { formatDateTime, formatNumber, formatTime } from "../../format";
import { api } from "../../services";
import { HELP } from "../../ui/help";
import { Button, DataTable, ErrorNotice, Loading, Panel } from "../../ui/kit";
import { useApi } from "../../ui/use-api";

/**
 * Входящие запросы: график ответов по времени и таблица маршрутов. Адресов и
 * игроков в журнале нет — только шаблон маршрута, класс ответа и корзина
 * времени, поэтому медиана и p95 точны до границы корзины.
 */
export function InboundTab({ period }: { period: RequestPeriod }) {
  const { state, reload } = useApi(() => fetchInbound(api, period), [period]);

  return (
    <>
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok" ? (
        <>
          <Panel title="Ответы по времени" help={HELP.requests.inbound} actions={<Button onClick={reload}>Обновить</Button>}>
            <Chart report={state.data} />
          </Panel>
          <Panel title="Маршруты">
            <Routes report={state.data} />
          </Panel>
        </>
      ) : null}
    </>
  );
}

/** Подпись оси: в пределах суток хватает времени, на неделе нужна дата. */
function axisLabel(at: string, step: Inbound["step"], period: string): string {
  return step === "minute" || period === "day" ? formatTime(at) : formatDateTime(at);
}

/**
 * Столбики на CSS, как у остальных графиков панели: Recharts в панель ещё не
 * встал (WP32). 5xx — тем же столбцом, но красной нижней частью: по высоте
 * видно и объём, и долю отказов.
 */
function Chart({ report }: { report: Inbound }) {
  const grouped = groupSeries(report.series, MAX_CHART_BARS);
  const { max, bars } = seriesChart(grouped);
  const total = grouped.reduce((sum, point) => sum + point.total, 0);
  const errors = grouped.reduce((sum, point) => sum + point.errors, 0);
  if (total === 0) return <p className="text-sm text-text-muted">За этот период ответов не было</p>;
  const first = grouped[0];
  const last = grouped.at(-1);
  const unit = report.step === "minute" ? "мин" : "ч";
  const step = report.step === "minute" ? "минуту" : "час";
  // Склеенные шаги — один столбец: максимум считается по нему, а не по одному шагу.
  const stepsPerBar = grouped.reduce((most, point) => Math.max(most, point.steps), 1);
  return (
    <div className="flex flex-col gap-1">
      <div
        className="flex h-32 min-w-0 items-end gap-px overflow-hidden"
        role="img"
        aria-label={`Ответы сервера: всего ${formatNumber(total)}, из них 5xx — ${formatNumber(errors)}, самый нагруженный шаг — ${formatNumber(max)}`}
      >
        {grouped.map((point, index) => {
          const bar = bars[index];
          if (bar === undefined) return null;
          const span = point.steps > 1 ? ` (${String(point.steps)} ${unit})` : "";
          return (
            <span
              key={point.at}
              title={`${axisLabel(point.at, report.step, report.period)}${span}: ${formatNumber(point.total)}${point.errors === 0 ? "" : `, из них 5xx ${formatNumber(point.errors)}`}`}
              className="relative flex h-full min-w-0 flex-1 items-end"
            >
              <span className={`w-full rounded-t-sm ${point.total === 0 ? "bg-surface-raised" : "bg-accent"}`} style={{ height: `${String(Math.max(point.total === 0 ? 2 : 4, Math.round(bar.total * 100)))}%` }}>
                {point.errors === 0 ? null : <span className="absolute bottom-0 left-0 w-full bg-danger" style={{ height: `${String(Math.max(4, Math.round(bar.errors * 100)))}%` }} />}
              </span>
            </span>
          );
        })}
      </div>
      <p className="flex flex-wrap justify-between gap-x-3 text-xs text-text-muted">
        <span>{first === undefined ? "" : axisLabel(first.at, report.step, report.period)}</span>
        <span>
          всего {formatNumber(total)} · 5xx {formatNumber(errors)} · максимум за {stepsPerBar > 1 ? `${String(stepsPerBar)} ${unit}` : step} {formatNumber(max)}
        </span>
        <span>{last === undefined ? "" : axisLabel(last.at, report.step, report.period)}</span>
      </p>
      <p className="flex items-center gap-3 text-xs text-text-muted">
        <span className="flex items-center gap-1">
          <span className="inline-block size-2 rounded-sm bg-accent" aria-hidden="true" />
          все ответы
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block size-2 rounded-sm bg-danger" aria-hidden="true" />
          5xx
        </span>
      </p>
    </div>
  );
}

function Routes({ report }: { report: Inbound }) {
  return (
    <DataTable
      rows={report.routes}
      rowKey={(row) => `${row.method} ${row.route}`}
      empty="За этот период ответов не было"
      columns={[
        {
          title: "Маршрут",
          primary: true,
          render: (row) => (
            <span className="break-all font-mono text-xs">
              <span className="text-text-muted">{row.method}</span> {row.route}
            </span>
          ),
        },
        { title: "Ответов", align: "right", render: (row) => formatNumber(row.count) },
        { title: "4xx", align: "right", render: (row) => (row.c4xx === 0 ? "0" : `${formatNumber(row.c4xx)} · ${formatShare(row.c4xx / row.count)}`) },
        {
          title: "5xx",
          align: "right",
          render: (row) =>
            row.c5xx === 0 ? (
              "0"
            ) : (
              <span className={serverErrorTone(row.count, row.c5xx) === "danger" ? "font-semibold text-danger" : ""}>{`${formatNumber(row.c5xx)} · ${formatShare(row.c5xx / row.count)}`}</span>
            ),
        },
        { title: "Медиана", align: "right", render: (row) => formatLatency(row.median) },
        { title: "p95", align: "right", render: (row) => formatLatency(row.p95) },
      ]}
    />
  );
}
