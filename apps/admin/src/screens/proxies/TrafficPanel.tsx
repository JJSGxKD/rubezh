import { useState } from "react";
import { fetchProxyTraffic, TRAFFIC_PERIODS, type TrafficPeriod, type TrafficReport } from "../../api/proxy-traffic";
import { api } from "../../services";
import { HELP } from "../../ui/help";
import { Button, DataTable, ErrorNotice, Loading, Notice, Panel, type Column } from "../../ui/kit";
import { useApi } from "../../ui/use-api";
import { periodLabel, subscriptionTotals, trafficRows, windowLabel, type TrafficRow } from "./traffic-view";

/**
 * Блок «Трафик через узлы Xray» под подписками (docs/35-stage4-plan.md Р192,
 * tasks/T-0386): сколько сервер прогнал через каждый узел и подписку за сутки, 7 и
 * 30 дней. Считает ядро Xray на нашем сервере, а не поставщик. Только чтение:
 * блок виден с `proxies.view`, кнопок правки нет.
 */
const COLUMNS: Column<TrafficRow>[] = [
  // Ушедший из подписки узел подписан в самом названии: «Берлин (нет в подписке)».
  { title: "Узел", primary: true, render: (row) => <span className="font-medium">{row.name}</span> },
  { title: "Подписка", render: (row) => row.subscriptionName },
  { title: "Отдано", align: "right", render: (row) => <span className="tabular-nums">{row.upText}</span> },
  { title: "Получено", align: "right", render: (row) => <span className="tabular-nums">{row.downText}</span> },
  { title: "Всего", align: "right", render: (row) => <span className="font-medium tabular-nums">{row.totalText}</span> },
];

const chip = (selected: boolean): string =>
  `min-h-8 rounded-sm px-2.5 text-xs font-semibold transition-colors max-md:min-h-10 ${selected ? "bg-surface-raised text-text shadow-[inset_0_0_0_1px_var(--color-border-strong)]" : "text-text-muted hover:text-text"}`;

function Report({ report }: { report: TrafficReport }) {
  const rows = trafficRows(report);
  return (
    <div className="flex flex-col gap-3">
      {report.lastCollectedAt === null ? (
        <Notice tone="info">Сервер ещё не получил счётчики Xray: контейнер не подключён или не отвечает. На машине разработчика так и должно быть.</Notice>
      ) : null}
      <p className="text-xs text-text-muted tabular-nums">{windowLabel(report)}</p>
      {report.subscriptions.length === 0 ? null : (
        <ul className="flex flex-col gap-1 text-sm">
          {subscriptionTotals(report).map((total) => (
            <li key={total.key}>{total.text}</li>
          ))}
        </ul>
      )}
      <DataTable columns={COLUMNS} rows={rows} rowKey={(row) => row.key} empty="За этот период трафика через узлы не было" />
    </div>
  );
}

export function TrafficPanel() {
  const [period, setPeriod] = useState<TrafficPeriod>("day");
  const { state, reload } = useApi(() => fetchProxyTraffic(api, period), [period]);

  return (
    <Panel title="Трафик через узлы Xray" help={HELP.proxies.traffic} actions={<Button onClick={reload}>Обновить</Button>}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-text-muted">Сколько сервер прогнал через узлы — считает ядро Xray на нашем сервере. Поставщик считает по-своему, его цифры — в карточке подписки.</p>
        <span className="inline-flex gap-0.5 self-start rounded-sm border border-border bg-surface-sunken p-0.5" role="tablist" aria-label="Период">
          {TRAFFIC_PERIODS.map((value) => (
            <button key={value} type="button" role="tab" aria-selected={period === value} onClick={() => setPeriod(value)} className={chip(period === value)}>
              {periodLabel(value)}
            </button>
          ))}
        </span>
        {state.status === "loading" ? <Loading /> : null}
        {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
        {state.status === "ok" ? <Report report={state.data} /> : null}
      </div>
    </Panel>
  );
}
