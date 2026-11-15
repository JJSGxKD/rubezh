import { useEffect, useState } from "react";
import {
  csvDate,
  fetchCustomerReport,
  fetchCustomers,
  formatCents,
  formatPercent,
  reportCsv,
  reportFileName,
  reportPeriodProblem,
  retentionText,
  type CustomerReport as Report,
  type ReportRow,
  type RetentionCell,
} from "../../api/customer-report";
import { formatNumber } from "../../format";
import { api } from "../../services";
import { useSession } from "../../state/use-session";
import { HELP } from "../../ui/help";
import { Button, DataTable, ErrorNotice, Field, Loading, Notice, Panel, Select } from "../../ui/kit";
import { PeriodPicker, valueDates, type PeriodValue } from "../../ui/period-picker";
import { navigate, useHashRoute } from "../../ui/router";
import { saveFile } from "../../ui/save-file";
import { TabBar } from "../../ui/tab-bar";
import { useApi } from "../../ui/use-api";
import { TasksScreen } from "./TasksScreen";

/** Вкладки раздела «Задания»: каталог и отчёт заказчику. Отчёт видят с правом `partners.view`. */
const TASK_TABS = [
  { id: "catalog", title: "Задания" },
  { id: "report", title: "Отчёт заказчику" },
] as const;
type TaskTab = (typeof TASK_TABS)[number]["id"];

/**
 * Раздел «Задания» с вкладкой отчёта (docs/35-stage4-plan.md Р140,
 * tasks/T-0225). Вкладка отчёта — только у тех, у кого есть право
 * `partners.view`: сервер проверит его сам, а лишнюю вкладку не показываем.
 */
export function TasksSection() {
  const canReport = useSession((session) => session.view.status === "ready" && session.view.identity.permissions.includes("partners.view"));
  const requested = useHashRoute()?.id;
  const tab: TaskTab = canReport && requested === "report" ? "report" : "catalog";
  if (!canReport) return <TasksScreen />;
  return (
    <div className="flex flex-col gap-4">
      <TabBar label="Задания" tabs={TASK_TABS} active={tab} onSelect={(next) => navigate({ section: "tasks", id: next === "catalog" ? null : next })} />
      {tab === "report" ? <CustomerReport /> : <TasksScreen />}
    </div>
  );
}

const DEFAULT_PERIOD: PeriodValue = { preset: 30 };

/**
 * Отчёт заказчику: выбор заказчика и периода, таблица по дням и заданиям,
 * итоги и «Скачать CSV». Только счётчики — игроков здесь нет. Деньги — по
 * ставке CPA и отметкам удержания; доля дохода (RS) — по отчёту заказчика.
 */
export function CustomerReport() {
  const customers = useApi(() => fetchCustomers(api), []);
  const canExport = useSession((session) => session.view.status === "ready" && session.view.identity.permissions.includes("data.export"));
  const [customer, setCustomer] = useState("");
  const [period, setPeriod] = useState<PeriodValue>(DEFAULT_PERIOD);
  const [now] = useState(() => new Date());

  const list = customers.state.status === "ok" ? customers.state.data : null;
  useEffect(() => {
    // Первый заказчик из списка выбран сразу: пустой экран с селектом — лишний шаг.
    if (list !== null && customer === "" && list[0] !== undefined) setCustomer(list[0]);
  }, [list, customer]);

  if (customers.state.status === "loading") return <Loading />;
  if (customers.state.status === "error") return <ErrorNotice error={customers.state.error} onRetry={customers.reload} />;
  if (customers.state.data.length === 0) return <Notice tone="info">Заказчиков пока нет: укажите заказчика в партнёрском задании, и здесь появится отчёт по нему.</Notice>;

  const dates = valueDates(period, now);
  const problem = dates === null ? "Укажите период" : reportPeriodProblem(dates.from, dates.to);

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Заказчик и период" help={HELP.customerReport.privacy}>
        <div className="flex flex-col gap-3">
          <Field label="Заказчик">
            <Select value={customer} onChange={(event) => setCustomer(event.target.value)} className="w-full max-w-sm">
              {customers.state.data.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <PeriodPicker value={period} now={now} onChange={setPeriod} />
          {problem === null ? null : <Notice tone="warning">{problem}</Notice>}
        </div>
      </Panel>
      {customer === "" || dates === null || problem !== null ? null : <ReportBody customer={customer} from={dates.from} to={dates.to} canExport={canExport} />}
    </div>
  );
}

function ReportBody({ customer, from, to, canExport }: { customer: string; from: string; to: string; canExport: boolean }) {
  const { state, reload } = useApi(() => fetchCustomerReport(api, customer, from, to), [customer, from, to]);
  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const report = state.data;

  return (
    <>
      <Totals report={report} />
      <Panel
        title="По дням и заданиям"
        actions={
          canExport ? (
            <Button disabled={report.rows.length === 0} onClick={() => saveFile(new Blob([reportCsv(report)], { type: "text/csv;charset=utf-8" }), reportFileName(report))}>
              Скачать CSV
            </Button>
          ) : undefined
        }
      >
        <ReportTable report={report} />
      </Panel>
    </>
  );
}

function money(cents: number): string {
  return `$${formatCents(cents)}`;
}

function Totals({ report }: { report: Report }) {
  const { totals, conversions } = report;
  const pay = !totals.hasRevenueShare ? money(totals.amountCents) : totals.amountCents === 0 ? "по отчёту заказчика" : `${money(totals.amountCents)} + по отчёту заказчика`;
  return (
    <Panel title="Всего за период" help={HELP.customerReport.conversions}>
      <p className="text-sm">
        Показов {formatNumber(totals.shown)}, нажатий {formatNumber(totals.opened)}, выполнений {formatNumber(totals.completed)}, остались на 7-й день{" "}
        {formatNumber(totals.retention.d7.kept)}, к оплате <strong className="font-semibold">{pay}</strong>
      </p>
      <p className="mt-1 text-xs text-text-muted">
        Нажатия к показам {formatPercent(conversions.opened)} · выполнения к нажатиям {formatPercent(conversions.completed)} · остались на 7-й день к выполнениям {formatPercent(conversions.keptD7)}
      </p>
    </Panel>
  );
}

/** Удержание ячейкой: число, «ещё рано» или «неизвестно»; сколько отметок ещё ждут — мелко рядом. */
function Retention({ cell, completed }: { cell: RetentionCell; completed: number }) {
  const view = retentionText(cell, completed);
  if (view.kind === "early") return <span className="text-text-muted">ещё рано</span>;
  if (view.kind === "unknown") return <span className="text-text-muted">неизвестно</span>;
  return (
    <span className="tabular-nums">
      {formatNumber(view.kept)}
      {view.pending > 0 ? <span className="ml-1 text-xs text-text-muted">+{formatNumber(view.pending)} ещё рано</span> : null}
    </span>
  );
}

function ReportTable({ report }: { report: Report }) {
  return (
    <DataTable<ReportRow>
      rows={report.rows}
      rowKey={(row) => `${row.day}|${row.taskId}`}
      empty="У заказчика нет выполнений за период"
      columns={[
        { title: "День", render: (row) => csvDate(row.day), primary: true },
        { title: "Задание", render: (row) => row.title },
        { title: "Показы", render: (row) => formatNumber(row.shown), align: "right" },
        { title: "Нажатия", render: (row) => formatNumber(row.opened), align: "right" },
        { title: "Выполнения", render: (row) => formatNumber(row.completed), align: "right" },
        { title: "1-й день", render: (row) => <Retention cell={row.retention.d1} completed={row.completed} />, align: "right", help: HELP.customerReport.retention },
        { title: "3-й день", render: (row) => <Retention cell={row.retention.d3} completed={row.completed} />, align: "right" },
        { title: "7-й день", render: (row) => <Retention cell={row.retention.d7} completed={row.completed} />, align: "right" },
        {
          title: "К оплате",
          render: (row) => (row.amountCents === null ? <span className="text-text-muted">по отчёту заказчика</span> : <span className="tabular-nums">{money(row.amountCents)}</span>),
          align: "right",
          help: HELP.customerReport.pay,
        },
      ]}
    />
  );
}
