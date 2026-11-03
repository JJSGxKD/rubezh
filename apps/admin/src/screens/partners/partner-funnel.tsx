import { useState } from "react";
import { FUNNEL_STEPS, funnelBars, platformTitle, presetPeriod, periodFromDates, shareOfAccounts, worstStep, type FunnelRow, type FunnelStep } from "../../api/funnel";
import { FUNNEL_HELP, NO_FUNNEL_PLAYERS, fetchPartnerFunnel, funnelRowOf, sourceTitle, type PartnerFunnel } from "../../api/partners";
import { formatDateTime, formatNumber } from "../../format";
import { api } from "../../services";
import { Button, DataTable, ErrorNotice, Help, Loading, Notice, type Column } from "../../ui/kit";
import { customProblem, DEFAULT_PRESET, PeriodPicker, type PeriodValue } from "../../ui/period-picker";
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

const ALL_PLAYERS = "Все игроки партнёра";

/** Строка разреза: название и вехи числами. */
interface Slice {
  key: string;
  title: string;
  row: FunnelRow;
}

function slicesOf(funnel: PartnerFunnel): { sources: Slice[]; platforms: Slice[] } {
  return {
    sources: funnel.sources.map((source) => ({
      key: `${source.via}|${source.ref ?? ""}|${source.name ?? ""}`,
      title: sourceTitle(source),
      hint: null,
      row: funnelRowOf(source.counts, sourceTitle(source)),
    })),
    platforms: funnel.platforms.map((item) => ({ key: item.platform, title: platformTitle(item.platform), row: funnelRowOf(item.counts, platformTitle(item.platform)) })),
  };
}

/**
 * Воронка игроков партнёра в его карточке (Р96, T-0068): сверху полосами по
 * всем привязанным, ниже — по источнику привязки (ссылка или код) и по
 * площадке. Вехи те же девять, что на экране «Воронка», и считаются теми же
 * функциями; период — по дате привязки, «7 · 30 · 90 · свой» тем же выбором.
 */
export function PartnerFunnelBlock({ partnerId }: { partnerId: string }) {
  const [value, setValue] = useState<PeriodValue>({ preset: DEFAULT_PRESET });
  const [window, setWindow] = useState<Window>(() => windowOf({ preset: DEFAULT_PRESET }) as Window);
  const { state, reload } = useApi(() => fetchPartnerFunnel(api, partnerId, window), [partnerId, window.from, window.to]);

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
          <Help text={FUNNEL_HELP.block} />
        </h3>
        <Button onClick={refresh}>Обновить</Button>
      </div>
      <PeriodPicker value={value} onChange={choose} />
      {problem !== null ? <Notice tone="warning">{problem}: показан прежний период.</Notice> : null}
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={refresh} /> : null}
      {state.status === "ok" ? <Loaded funnel={state.data} /> : null}
    </section>
  );
}

function Loaded({ funnel }: { funnel: PartnerFunnel }) {
  if (funnel.total.accounts === 0) return <p className="text-sm text-text-muted">{NO_FUNNEL_PLAYERS}</p>;
  const total = funnelRowOf(funnel.total, ALL_PLAYERS);
  const bars = funnelBars(total, null);
  const { sources, platforms } = slicesOf(funnel);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-text-muted">
        Привязаны с {formatDateTime(funnel.from)} по {formatDateTime(funnel.to)}. Игроков: {formatNumber(total.accounts)}.
      </p>
      <FunnelChart bars={bars} worst={worstStep(bars)} compare={false} />
      <SliceTable title="По источнику привязки" help={FUNNEL_HELP.sources} first="Источник" slices={sources} />
      <SliceTable title="По площадке" help={FUNNEL_HELP.platforms} first="Площадка" slices={platforms} />
    </div>
  );
}

function SliceTable({ title, help, first, slices }: { title: string; help: string; first: string; slices: readonly Slice[] }) {
  const cell = (row: FunnelRow, step: FunnelStep) => {
    const share = shareOfAccounts(row, step);
    return (
      <span className="inline-flex flex-col items-end whitespace-nowrap">
        {formatNumber(row[step])}
        {share === null || step === "entered" ? null : <span className="text-xs text-text-muted">{share}%</span>}
      </span>
    );
  };
  const columns: Column<Slice>[] = [
    { title: first, render: (slice) => <span className="flex max-w-72 flex-col">{slice.title}</span> },
    { title: "Игроков", render: (slice) => formatNumber(slice.row.accounts), align: "right" },
    ...FUNNEL_STEPS.map(([step, stepTitle]): Column<Slice> => ({ title: stepTitle, render: (slice) => cell(slice.row, step), align: "right" })),
  ];
  return (
    <section className="flex flex-col gap-2 border-t border-border pt-3">
      <h4 className="flex items-center gap-1.5 text-sm font-semibold">
        {title}
        <Help text={help} />
      </h4>
      <DataTable rows={[...slices]} rowKey={(slice) => slice.key} empty={NO_FUNNEL_PLAYERS} columns={columns} />
    </section>
  );
}
