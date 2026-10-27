import { formatNumber } from "../../format";
import type { FunnelBar } from "../../api/funnel";
import { HELP } from "../../ui/help";
import { Help } from "../../ui/kit";
import { useNarrow } from "../../ui/use-media";

/** Подписи вех под названием — что значит веха, как в макете. */
const STEP_HINTS: Readonly<Record<string, string>> = {
  entered: "вошли в бота или по ссылке",
  appOpened: "открыли игру",
  firstRunStarted: "начали",
  firstRunFinished: "закончили первый",
  returnedD1: "на следующий день",
  returnedD7: "через неделю",
  firstPurchase: "первая за звёзды",
};

const percent = (ratio: number): string => `${String(Math.round(ratio * 100))}%`;

/**
 * Воронка новичков полосами по строке «Все источники» (design/screens/admin-funnel.html):
 * ширина полосы — доля от «Входа», справа — доля от входа, доля от прошлой
 * вехи и изменение к прошлому периоду; черта на полосе — где был прошлый
 * период. Отметка «больше всего теряем» стоит строкой над вехой `worst`.
 */
export function FunnelChart({ bars, worst, compare }: { bars: readonly FunnelBar[]; worst: number | null; compare: boolean }) {
  const narrow = useNarrow();
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-center gap-1 text-xs text-text-muted">
        Ширина полосы — доля от вошедших
        <Help text={HELP.funnel.chart} />
      </p>
      {bars.map((bar, index) => (
        <div key={bar.step} className="flex flex-col gap-1.5">
          {index === worst ? <WorstNote previous={bars[index - 1]} bar={bar} /> : null}
          <div className={narrow ? "flex flex-col gap-1" : "grid grid-cols-[150px_1fr_300px] items-center gap-3"}>
            <span className="text-sm">
              {bar.title}
              {STEP_HINTS[bar.step] === undefined ? null : <small className="block text-xs text-text-muted">{STEP_HINTS[bar.step]}</small>}
            </span>
            <Track bar={bar} compare={compare} />
            <Stats bar={bar} compare={compare} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Track({ bar, compare }: { bar: FunnelBar; compare: boolean }) {
  const before = compare && bar.deltaPts !== null ? bar.ofFirst - bar.deltaPts / 100 : null;
  return (
    <div className="relative h-[26px] overflow-hidden rounded-sm bg-surface-sunken" role="img" aria-label={`${bar.title}: ${formatNumber(bar.count)}, ${percent(bar.ofFirst)} от входа`}>
      <div className="absolute inset-y-0 left-0 flex items-center rounded-sm bg-accent/65 pl-2 text-xs font-semibold text-on-accent tabular-nums" style={{ width: `${String(Math.max(0.5, bar.ofFirst * 100))}%` }}>
        {bar.ofFirst > 0.08 ? formatNumber(bar.count) : null}
      </div>
      {before === null ? null : <div aria-hidden="true" className="absolute inset-y-0 w-0.5 bg-text/55" style={{ left: `${String(Math.min(100, Math.max(0, before * 100)))}%` }} />}
    </div>
  );
}

function Stats({ bar, compare }: { bar: FunnelBar; compare: boolean }) {
  // У «Входа» изменение — число аккаунтов в процентах, у остальных — доля от входа в п. п.
  const change = !compare || bar.deltaPts === null ? null : bar.ofPrev === null ? entryChange(bar) : { value: bar.deltaPts, text: `${bar.deltaPts > 0 ? "+" : "−"}${String(Math.abs(bar.deltaPts)).replace(".", ",")} п. п.` };
  return (
    <span className="flex flex-wrap gap-x-3 text-xs text-text-muted tabular-nums">
      <span>
        <b className="font-semibold text-text">{formatNumber(bar.count)}</b>
      </span>
      <span>{percent(bar.ofFirst)} от входа</span>
      <span>{bar.ofPrev === null ? "—" : `${percent(bar.ofPrev)} от прошлого`}</span>
      {change === null ? null : <span className={change.value === 0 ? "" : change.value > 0 ? "text-success" : "text-danger"}>{change.text}</span>}
    </span>
  );
}

function entryChange(bar: FunnelBar): { value: number; text: string } | null {
  if (bar.countBefore === null || bar.countBefore === 0) return null;
  const pct = Math.round(((bar.count - bar.countBefore) / bar.countBefore) * 100);
  return { value: pct, text: pct === 0 ? "как раньше" : `${pct > 0 ? "+" : "−"}${String(Math.abs(pct))}% аккаунтов` };
}

function WorstNote({ previous, bar }: { previous: FunnelBar | undefined; bar: FunnelBar }) {
  const lost = bar.ofPrev === null ? 0 : 100 - Math.round(bar.ofPrev * 100);
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-warning md:ml-[162px]">
      <i className="rounded-sm bg-warning/15 px-1.5 py-0.5 text-[11px] font-bold not-italic">больше всего теряем</i>
      <span>{`${String(lost)}% не доходят от «${previous?.title ?? ""}» до «${bar.title}»`}</span>
      <Help text={HELP.funnel.worst} />
    </p>
  );
}
