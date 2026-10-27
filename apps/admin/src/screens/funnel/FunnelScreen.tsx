import { useState } from "react";
import { api } from "../../services";
import type { ApiResult } from "../../api/client";
import {
  fetchFunnel,
  filterByPlatform,
  FUNNEL_STEPS,
  funnelBars,
  funnelTotal,
  heatBackground,
  heatTone,
  periodFromDates,
  platformsOf,
  platformTitle,
  presetPeriod,
  previousPeriod,
  shareOfAccounts,
  sortRows,
  touchOf,
  worstStep,
  type FunnelReport,
  type FunnelRow,
  type FunnelStep,
} from "../../api/funnel";
import { formatDateTime, formatNumber } from "../../format";
import { Button, DataTable, ErrorNotice, Field, Loading, Notice, Panel, Select, type Column } from "../../ui/kit";
import { HELP } from "../../ui/help";
import { customProblem, DEFAULT_PRESET, PeriodPicker, type PeriodValue } from "../../ui/period-picker";
import { useApi } from "../../ui/use-api";
import { FlagSplitPanel } from "./FlagSplitPanel";
import { FunnelChart } from "./funnel-chart";

type Window = { from: string; to: string };

/** Период выбора в запрос: пресет — от «сейчас», свой — из дат; своего с ошибкой нет. */
function windowOf(value: PeriodValue): Window | null {
  if (value.preset !== "custom") return presetPeriod(value.preset, new Date());
  if (customProblem(value.from, value.to) !== null) return null;
  const { from, to } = periodFromDates(value.from, value.to);
  return from === undefined || to === undefined ? null : { from, to };
}

interface Loaded {
  now: FunnelReport;
  /** `null` — сравнение выключено; `"failed"` — прошлый период не загрузился */
  before: FunnelReport | null | "failed";
}

async function loadFunnel(window: Window, compare: boolean): Promise<ApiResult<Loaded>> {
  const [now, before] = await Promise.all([fetchFunnel(api, window), compare ? fetchFunnel(api, previousPeriod(window)) : Promise.resolve(null)]);
  if (!now.ok) return now;
  return { ok: true, data: { now: now.data, before: before === null ? null : before.ok ? before.data : "failed" } };
}

/**
 * Воронка по источникам. Сверху — полосами по строке «Все источники»: где
 * теряем новичков и что изменилось к прошлому периоду; ниже — таблица
 * источников, ячейка подсвечена по доле к общей. Число и доля от аккаунтов
 * строки в одной ячейке: абсолют без доли не сравнить между источниками, доля
 * без абсолюта врёт на малых числах (docs/29-admin-panel.md §5.2). Ещё ниже —
 * доля флага против остальных; `focus` — ключ флага из адреса, к нему ведут
 * «Флаги».
 */
export function FunnelScreen({ focus = null }: { focus?: string | null }) {
  const [value, setValue] = useState<PeriodValue>({ preset: DEFAULT_PRESET });
  const [window, setWindow] = useState<Window>(() => windowOf({ preset: DEFAULT_PRESET }) as Window);
  const [compare, setCompare] = useState(false);
  const [platform, setPlatform] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<"accounts" | FunnelStep>("accounts");
  const { state, reload } = useApi(() => loadFunnel(window, compare), [window.from, window.to, compare]);

  const choose = (next: PeriodValue) => {
    setValue(next);
    // Свой период с ошибкой не отправляется: прежний остаётся на экране.
    const resolved = windowOf(next);
    if (resolved !== null) setWindow(resolved);
  };
  // У своего периода окно не меняется, и одна смена окна запрос не повторила
  // бы: «Обновить» и «Повторить» после ошибки сети молча ничего не делали.
  const refresh = () => {
    setWindow(windowOf(value) ?? window);
    reload();
  };

  const problem = value.preset === "custom" ? customProblem(value.from, value.to) : null;

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Воронка новичков"
        help={HELP.funnel.funnel}
        actions={<Button onClick={refresh}>Обновить</Button>}
      >
        <div className="mb-4 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <PeriodPicker value={value} onChange={choose} />
          <div className="flex flex-wrap items-end gap-3">
            {state.status !== "ok" ? null : (
              <Field label="Площадка">
                <Select value={platform ?? ""} onChange={(event) => setPlatform(event.target.value === "" ? null : event.target.value)}>
                  <option value="">Все площадки</option>
                  {platformsOf(state.data.now.rows).map((item) => (
                    <option key={item} value={item}>
                      {platformTitle(item)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <label className="flex min-h-9 items-center gap-2 text-sm">
              <input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} className="size-4 accent-accent" />
              Сравнить с прошлым периодом
            </label>
          </div>
        </div>
        {problem !== null ? <Notice tone="warning">{problem}: показан прежний период.</Notice> : null}
        {state.status === "loading" ? <Loading /> : null}
        {state.status === "error" ? <ErrorNotice error={state.error} onRetry={refresh} /> : null}
        {state.status === "ok" ? <Report loaded={state.data} platform={platform} compare={compare} sortKey={sortKey} onSort={setSortKey} /> : null}
      </Panel>
      <FlagSplitPanel focus={focus} />
    </div>
  );
}

function Report({ loaded, platform, compare, sortKey, onSort }: { loaded: Loaded; platform: string | null; compare: boolean; sortKey: "accounts" | FunnelStep; onSort: (key: "accounts" | FunnelStep) => void }) {
  const rows = filterByPlatform(loaded.now.rows, platform);
  const before = loaded.before === null || loaded.before === "failed" ? null : filterByPlatform(loaded.before.rows, platform);
  const total = funnelTotal(rows);
  const bars = funnelBars(total, before === null ? null : funnelTotal(before));
  const showCompare = compare && before !== null;

  if (rows.length === 0) return <p className="text-sm text-text-muted">За период никто не пришёл</p>;

  const cell = (row: FunnelRow, step: FunnelStep, isTotal: boolean) => {
    const share = shareOfAccounts(row, step);
    const tone = isTotal || step === "entered" || row.accounts === 0 || total.accounts === 0 ? null : heatTone(row[step] / row.accounts, total[step] / total.accounts);
    const background = tone === null ? undefined : heatBackground(tone);
    return (
      <span className="inline-flex flex-col items-end rounded-xs px-1.5 py-0.5 whitespace-nowrap" style={background === undefined ? undefined : { background }}>
        {formatNumber(row[step])}
        {share === null || step === "entered" ? null : <span className="text-xs text-text-muted">{share}%</span>}
      </span>
    );
  };

  const columns: Column<FunnelRow>[] = [
    { title: "Откуда пришли", help: HELP.funnel.touch, render: (row) => <TouchCell row={row} withPlatform /> },
    { title: "Аккаунтов", render: (row) => formatNumber(row.accounts), align: "right" },
    ...FUNNEL_STEPS.map(
      ([step, title]): Column<FunnelRow> => ({
        title,
        render: (row) => cell(row, step, row === total),
        align: "right",
        ...(step === "returnedD1" || step === "returnedD7" ? { help: HELP.funnel.returned } : {}),
      }),
    ),
  ];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-text-muted">
        Период: {formatDateTime(loaded.now.from)} — {formatDateTime(loaded.now.to)}. Аккаунтов: {formatNumber(total.accounts)}.
        {showCompare && loaded.before !== null && loaded.before !== "failed" ? ` Прошлый период: ${formatDateTime(loaded.before.from)} — ${formatDateTime(loaded.before.to)}.` : ""}
      </p>
      {compare && loaded.before === "failed" ? <Notice tone="warning">Прошлый период не загрузился — показано без сравнения.</Notice> : null}
      <FunnelChart bars={bars} worst={worstStep(bars)} compare={showCompare} />
      <section className="flex flex-col gap-2 border-t border-border pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">По источникам</h3>
          <Field label="Сортировка">
            <Select value={sortKey} onChange={(event) => onSort(event.target.value as "accounts" | FunnelStep)}>
              <option value="accounts">По аккаунтам</option>
              {FUNNEL_STEPS.map(([step, title]) => (
                <option key={step} value={step}>
                  По вехе «{title}»
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <p className="text-xs text-text-muted">Ячейка подсвечена по доле против строки «Все источники»: зелёным — лучше, красным — хуже, от 3 п. п.</p>
        <DataTable
          rows={[total, ...sortRows(rows, sortKey)]}
          rowKey={(row) => `${row.platform}|${row.startKind}|${row.startRef ?? ""}|${row.startSource ?? ""}`}
          empty="За период никто не пришёл"
          columns={columns}
        />
      </section>
    </div>
  );
}

function TouchCell({ row, withPlatform = false }: { row: FunnelRow; withPlatform?: boolean }) {
  const touch = touchOf(row);
  return (
    <span className="flex max-w-72 flex-col">
      <span className={row.startKind === "все" ? "font-medium" : ""}>{touch.title}</span>
      {touch.detail === null ? null : <span className="text-xs text-text-muted">{touch.detail}</span>}
      {withPlatform && row.startKind !== "все" ? <span className="text-xs text-text-muted">{platformTitle(row.platform)}</span> : null}
    </span>
  );
}
