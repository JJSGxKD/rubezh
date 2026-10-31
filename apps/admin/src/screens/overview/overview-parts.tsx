import type { ReactNode } from "react";
import {
  BOARD_MARK_LABEL,
  boardMarkShare,
  completionPct,
  funnelBars,
  LOW_COMPLETION_PCT,
  networkShares,
  networkTitle,
  OVERVIEW_PERIODS,
  versusBefore,
  type AdsTotals,
  type BoardMark,
  type Overview,
  type OverviewDay,
  type OverviewAds,
  type OverviewDays,
} from "../../api/overview";
import { PLACE_TITLES, type AdPlace } from "../../api/ads";
import { formatNumber } from "../../format";
import { hrefOf } from "../../routes";
import { HELP } from "../../ui/help";
import { Badge, DataTable, Help, Panel } from "../../ui/kit";

const TONE_CLASS = { up: "text-success", down: "text-danger", flat: "text-text-muted" } as const;

export function Attention({ overview }: { overview: Overview }) {
  return (
    <Panel title="Ждёт вас" help={HELP.overview.attention}>
      {overview.attention.length === 0 ? (
        <p className="text-sm text-text-muted">Ничего не ждёт — всё разобрано.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {overview.attention.map((item) => (
            <li key={item.section} className="flex items-center justify-between gap-3 py-2">
              <span className="flex items-center gap-2 text-sm">
                <span className="inline-flex min-w-6 justify-center rounded-pill bg-warning/15 px-1.5 text-xs font-semibold text-warning tabular-nums">{formatNumber(item.count)}</span>
                {item.text}
              </span>
              <a href={hrefOf({ section: item.section, id: null })} className="shrink-0 text-sm text-accent hover:underline">
                Открыть
              </a>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Плитка с числом и сравнением с прошлым окном. `className` — как плитка встаёт в сетку. */
export function Tile({
  title,
  help,
  value,
  before,
  days,
  sub,
  className = "",
}: {
  title: string;
  help: string;
  value: number;
  before: number;
  days: OverviewDays;
  sub: ReactNode;
  className?: string;
}) {
  const delta = versusBefore(value, before, days);
  return (
    <div className={`flex min-w-0 flex-col gap-0.5 rounded-sm border border-border bg-surface-sunken px-3 py-2.5 ${className}`}>
      <span className="flex items-center gap-1 text-xs text-text-muted">
        {title}
        <Help text={help} />
      </span>
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-display text-2xl font-semibold tabular-nums">{formatNumber(value)}</span>
        <span className={`text-xs ${TONE_CLASS[delta.tone]}`}>{delta.text}</span>
      </span>
      <span className="truncate text-xs text-text-muted">{sub}</span>
    </div>
  );
}

export function Chart({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** Переключатель периода: «Сегодня · 7 дней · 30 дней». */
export function PeriodSwitch({ value, onChange }: { value: OverviewDays; onChange: (days: OverviewDays) => void }) {
  const titles: Record<OverviewDays, string> = { 1: "Сегодня", 7: "7 дней", 30: "30 дней" };
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-flex gap-0.5 rounded-sm border border-border bg-surface-sunken p-0.5" role="tablist" aria-label="Период">
        {OVERVIEW_PERIODS.map((days) => (
          <button
            key={days}
            type="button"
            role="tab"
            aria-selected={value === days}
            onClick={() => onChange(days)}
            className={`min-h-7 rounded-sm px-2.5 text-xs font-semibold transition-colors max-md:min-h-9 ${value === days ? "bg-surface-raised text-text shadow-[inset_0_0_0_1px_var(--color-border-strong)]" : "text-text-muted hover:text-text"}`}
          >
            {titles[days]}
          </button>
        ))}
      </span>
      <Help text={HELP.overview.period} />
    </span>
  );
}

/** Вехи полосами: высота — доля от «Вошли в бота», под полосой — число, название и доля от прошлой. */
export function FunnelBars({ funnel }: { funnel: Overview["today"]["funnel"] }) {
  const bars = funnelBars(funnel);
  return (
    <div className="mt-3 grid grid-cols-4 gap-x-1.5 gap-y-3 md:grid-cols-7">
      {bars.map((bar) => (
        <div key={bar.key} className="flex min-w-0 flex-col gap-1 text-xs text-text-muted">
          <div className="flex h-11 items-end overflow-hidden rounded-sm bg-surface-sunken" role="img" aria-label={`${bar.title}: ${formatNumber(bar.count)}`}>
            <div className="w-full rounded-t-sm bg-accent/60" style={{ height: `${String(Math.max(6, Math.round(bar.ofFirst * 100)))}%` }} />
          </div>
          <b className="font-display text-sm font-normal text-text tabular-nums">{formatNumber(bar.count)}</b>
          <span className="leading-tight">{bar.title}</span>
          <span>{bar.ofPrev === null ? "—" : `${String(bar.ofPrev)}% от прошлого`}</span>
        </div>
      ))}
    </div>
  );
}

const NETWORK_TONES = ["bg-info", "bg-passive", "bg-accent", "bg-warning"] as const;

const placeTitle = (place: string): string => PLACE_TITLES[place as AdPlace] ?? place;

type AdsRow = { key: string; title: string; total: boolean } & AdsTotals;

/** Реклама за период: места строками, итог, доли сетей. */
export function AdsPanel({ ads, days }: { ads: OverviewAds; days: OverviewDays }) {
  const total: AdsRow = { key: "total", title: "Всего", total: true, ...ads.now };
  const rows: AdsRow[] = [...ads.places.map((place) => ({ ...place, key: place.place, title: placeTitle(place.place), total: false })), total];
  const shares = networkShares(ads.networks);
  const empty = ads.now.offered === 0 && ads.now.shown === 0;
  const period = days === 1 ? "сегодня" : `за ${String(days)} дней`;

  return (
    <Panel
      title={`Реклама ${period}`}
      help={HELP.overview.adsPlaces}
      actions={
        <a href={hrefOf({ section: "ads", id: null })} className="text-sm text-accent hover:underline">
          В раздел «Реклама» →
        </a>
      }
    >
      {empty ? (
        <p className="text-sm text-text-muted">Показов за период не было</p>
      ) : (
        <>
          <DataTable
            rows={rows}
            rowKey={(row) => row.key}
            columns={[
              { title: "Место", render: (row) => <span className={`whitespace-nowrap ${row.total ? "font-semibold" : ""}`}>{row.title}</span> },
              { title: "Предложено", render: (row) => formatNumber(row.offered), align: "right", phone: "hide" },
              { title: "Показано", render: (row) => formatNumber(row.shown), align: "right", phone: "hide" },
              { title: "Досмотрено", render: (row) => <span className={row.total ? "font-semibold" : ""}>{formatNumber(row.completed)}</span>, align: "right" },
              { title: "Доля досмотра", render: (row) => <CompletionCell totals={row} />, align: "right" },
              { title: "Наград", render: (row) => formatNumber(row.claimed), align: "right", phone: "hide" },
              { title: "Ошибок", render: (row) => formatNumber(row.failed), align: "right", phone: "hide" },
              ...(ads.now.passed > 0 ? [{ title: "Пропуск VIP", render: (row: AdsRow) => formatNumber(row.passed), align: "right" as const, phone: "hide" as const }] : []),
            ]}
          />
          {shares.length === 0 ? null : (
            <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
              {shares.map((share, index) => (
                <span key={share.networkKey} className="whitespace-nowrap">
                  <i aria-hidden="true" className={`mr-1.5 inline-block size-2 rounded-xs ${NETWORK_TONES[index % NETWORK_TONES.length] ?? "bg-info"}`} />
                  {networkTitle(share.networkKey)} <b className="text-text tabular-nums">{String(share.pct)}%</b>
                </span>
              ))}
            </p>
          )}
          {ads.now.passed > 0 ? <p className="mt-1 text-xs text-text-muted">Пропуск VIP — награда без ролика у игроков с VIP. В досмотры, доли и сети не входит.</p> : null}
          {ads.places.some((place) => place.place === "interstitial") ? (
            <p className="mt-1 text-xs text-text-muted">У показа «Между забегами» наград нет — в колонке «Наград» у него ноль.</p>
          ) : null}
        </>
      )}
    </Panel>
  );
}

function CompletionCell({ totals }: { totals: AdsTotals }) {
  const pct = completionPct(totals);
  if (pct === null) return <span className="text-text-muted">—</span>;
  const low = pct < LOW_COMPLETION_PCT;
  return (
    <span className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap tabular-nums">
      {low ? <Badge tone="warning">{String(pct)}%</Badge> : <span>{String(pct)}%</span>}
      <span aria-hidden="true" className="hidden h-1.5 w-16 overflow-hidden rounded-pill bg-surface-sunken md:inline-block">
        <i className={`block h-full ${low ? "bg-warning" : "bg-info"}`} style={{ width: `${String(pct)}%` }} />
      </span>
    </span>
  );
}

/**
 * «Отдельная доска» — сколько аккаунтов под этим видом и какая часть забегов на
 * них приходится (T-0115). Блока нет, когда сервер прислал `null`: права нет или
 * чтение метки не ответило, а места под пустой блок экран не держит.
 */
export function BoardMarkPanel({ mark, today }: { mark: BoardMark | null; today: OverviewDay }) {
  if (mark === null) return null;
  const share = boardMarkShare(mark.today, today);
  const rows = [
    ["С видом", mark.today.marked, mark.yesterday.marked],
    ["Играли", mark.today.active, mark.yesterday.active],
    ["Новые", mark.today.newAccounts, mark.yesterday.newAccounts],
    ["Забегов", mark.today.runs, mark.yesterday.runs],
  ] as const;
  return (
    <Panel title={BOARD_MARK_LABEL}>
      <table className="w-full text-sm tabular-nums">
        <thead>
          <tr className="text-left text-xs text-text-muted">
            <th className="py-1 font-normal" />
            <th className="py-1 text-right font-normal">сейчас</th>
            <th className="py-1 text-right font-normal">вчера</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([title, now, before]) => (
            <tr key={title} className="border-t border-border">
              <td className="py-1.5">{title}</td>
              <td className="py-1.5 text-right">{formatNumber(now)}</td>
              <td className="py-1.5 text-right text-text-muted">{formatNumber(before)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {share === null ? null : <p className="mt-2 text-xs text-text-muted">{`На них ${String(share)}% завершённых забегов периода.`}</p>}
    </Panel>
  );
}
