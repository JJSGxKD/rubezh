import { useState } from "react";
import { CABINET_FUNNEL_TEXTS, clicksLine, fetchCabinetFunnel, funnelSourceTitle, hiddenRowText, tooFewText, type CabinetFunnel } from "../../api/cabinet";
import { FUNNEL_STEPS, funnelBars, periodFromDates, platformTitle, presetPeriod, shareOfAccounts, worstStep, type FunnelRow, type FunnelStep } from "../../api/funnel";
import { funnelRowOf, type PartnerFunnelCounts } from "../../api/partners";
import { formatNumber } from "../../format";
import { api } from "../../services";
import { Button, DataTable, ErrorNotice, Help, Loading, Notice, type Column } from "../../ui/kit";
import { DEFAULT_PRESET, PeriodPicker, customProblem, periodLabel, type PeriodValue } from "../../ui/period-picker";
import { useApi } from "../../ui/use-api";
import { FunnelChart } from "../funnel/funnel-chart";

type Window = { from: string; to: string };

/** Период выбора в запрос: пресет — от «сейчас», свой — из дат; своего с ошибкой нет. */
function windowOf(value: PeriodValue): Window | null {
  if (value.preset !== "custom") return presetPeriod(value.preset, new Date());
  if (customProblem(value.from, value.to) !== null) return null;
  const { from, to } = periodFromDates(value.from, value.to);
  return from === undefined || to === undefined ? null : { from, to };
}

/** Вехи в таблицах кабинета: вход, первый забег, возвраты на 1-й и 7-й день, покупка; полные девять — в полосах. */
const TABLE_STEPS: readonly FunnelStep[] = ["entered", "firstRunStarted", "returnedD1", "returnedD7", "firstPurchase"];
const STEP_TITLES = new Map<FunnelStep, string>(FUNNEL_STEPS);

/** Строка таблицы: название и вехи; `row: null` — игроков меньше порога, чисел нет. */
interface Slice {
  key: string;
  title: string;
  row: FunnelRow | null;
}

function Cell({ row, step }: { row: FunnelRow; step: FunnelStep }) {
  const share = shareOfAccounts(row, step);
  return (
    <span className="inline-flex flex-col items-end whitespace-nowrap">
      {formatNumber(row[step])}
      {share === null || step === "entered" ? null : <span className="text-xs text-text-muted">{share}%</span>}
    </span>
  );
}

function SliceTable({ title, help, first, slices, minGroup, footer }: { title: string; help: string; first: string; slices: readonly Slice[]; minGroup: number; footer?: string | null }) {
  const columns: Column<Slice>[] = [
    { title: first, primary: true, render: (slice) => <span className="flex max-w-72 flex-col break-words">{slice.title}</span> },
    {
      title: "Игроков",
      align: "right",
      render: (slice) => (slice.row === null ? <span className="text-xs text-text-muted">{hiddenRowText(minGroup)}</span> : formatNumber(slice.row.accounts)),
    },
    ...TABLE_STEPS.map(
      (step): Column<Slice> => ({ title: STEP_TITLES.get(step) ?? step, align: "right", render: (slice) => (slice.row === null ? null : <Cell row={slice.row} step={step} />) }),
    ),
  ];
  return (
    <section className="flex flex-col gap-2 border-t border-border pt-3">
      <h4 className="flex items-center gap-1.5 text-sm font-semibold">
        {title}
        <Help text={help} />
      </h4>
      <DataTable rows={[...slices]} rowKey={(slice) => slice.key} empty={CABINET_FUNNEL_TEXTS.empty} columns={columns} />
      {footer === null || footer === undefined ? null : <p className="text-xs text-text-muted">{footer}</p>}
    </section>
  );
}

const rowOf = (counts: PartnerFunnelCounts | null, label: string): FunnelRow | null => (counts === null ? null : funnelRowOf(counts, label));

function slicesOf(funnel: CabinetFunnel) {
  return {
    sources: funnel.sources.map((source): Slice => {
      const title = funnelSourceTitle(source);
      return { key: `${source.via}|${source.ref ?? ""}|${source.name ?? ""}`, title, row: rowOf(source.counts, title) };
    }),
    platforms: funnel.platforms.map((item): Slice => ({ key: item.platform, title: platformTitle(item.platform), row: rowOf(item.counts, platformTitle(item.platform)) })),
    days: funnel.days.map((item): Slice => ({ key: item.day, title: periodLabel(item.day, item.day), row: rowOf(item.counts, item.day) })),
  };
}

const ALL_PLAYERS = "Все игроки партнёра";

function Loaded({ funnel, days }: { funnel: CabinetFunnel; days: number | null }) {
  const clicks = <p className="text-sm font-medium">{clicksLine(funnel.clicks, days)}</p>;
  if (funnel.total === null) {
    return (
      <div className="flex flex-col gap-3">
        {clicks}
        {funnel.clicks === 0 ? <p className="text-sm text-text-muted">{CABINET_FUNNEL_TEXTS.empty}</p> : <Notice tone="info">{tooFewText(funnel.minGroup)}</Notice>}
      </div>
    );
  }
  const bars = funnelBars(funnelRowOf(funnel.total, ALL_PLAYERS), null);
  const { sources, platforms, days: byDay } = slicesOf(funnel);
  return (
    <div className="flex flex-col gap-4">
      {clicks}
      <p className="text-xs text-text-muted">Пришло игроков: {formatNumber(funnel.total.accounts)}</p>
      <FunnelChart bars={bars} worst={worstStep(bars)} compare={false} />
      <SliceTable title="По ссылкам и кодам" help={CABINET_FUNNEL_TEXTS.sources} first="Откуда" slices={sources} minGroup={funnel.minGroup} />
      <SliceTable title="По площадкам" help={CABINET_FUNNEL_TEXTS.platforms} first="Площадка" slices={platforms} minGroup={funnel.minGroup} />
      <SliceTable
        title="По дням"
        help={CABINET_FUNNEL_TEXTS.days}
        first="День"
        slices={byDay}
        minGroup={funnel.minGroup}
        footer={funnel.hiddenDays === 0 ? null : CABINET_FUNNEL_TEXTS.daysHidden(funnel.hiddenDays)}
      />
    </div>
  );
}

/**
 * Вкладка «Воронка» (docs/35-stage4-plan.md Р136, tasks/T-0219): переходы по ссылкам, полосы вех по всем игрокам
 * партнёра и разрезы по ссылкам и кодам, площадкам и дням. Период — «7 · 30 · 90 · свой» тем же выбором, что
 * в остальных отчётах, по дню привязки игрока. Срезы меньше порога сервер присылает без чисел — здесь только
 * строка «меньше N игроков — не показываем».
 */
export function FunnelTab({ partnerId }: { partnerId: string | null }) {
  const [value, setValue] = useState<PeriodValue>({ preset: DEFAULT_PRESET });
  const [window, setWindow] = useState<Window>(() => windowOf({ preset: DEFAULT_PRESET }) as Window);
  const { state, reload } = useApi(() => fetchCabinetFunnel(api, partnerId, window), [partnerId, window.from, window.to]);

  const choose = (next: PeriodValue) => {
    setValue(next);
    // Свой период с ошибкой не отправляется: прежний остаётся на экране.
    const resolved = windowOf(next);
    if (resolved !== null) setWindow(resolved);
  };
  const refresh = () => {
    setWindow(windowOf(value) ?? window);
    reload();
  };
  const problem = value.preset === "custom" ? customProblem(value.from, value.to) : null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          Воронка игроков
          <Help text={CABINET_FUNNEL_TEXTS.help} />
        </h3>
        <Button onClick={refresh}>Обновить</Button>
      </div>
      <PeriodPicker value={value} onChange={choose} />
      {problem !== null ? <Notice tone="warning">{problem}: показан прежний период.</Notice> : null}
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={refresh} /> : null}
      {state.status === "ok" ? <Loaded funnel={state.data} days={value.preset === "custom" ? null : value.preset} /> : null}
    </section>
  );
}
