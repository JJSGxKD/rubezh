import { useEffect, type ReactNode } from "react";
import { OVERVIEW_REFRESH_MS, dayTitle, fetchOverview, newAccounts, sourcesLine, versusYesterday, type Overview } from "../../api/overview";
import { formatDuration, formatNumber, formatTime } from "../../format";
import { hrefOf } from "../../routes";
import { api } from "../../services";
import { DailyBars } from "../../ui/daily-bars";
import { HELP } from "../../ui/help";
import { Button, ErrorNotice, Help, Loading, Panel } from "../../ui/kit";
import { useApi } from "../../ui/use-api";

const TONE_CLASS = { up: "text-success", down: "text-danger", flat: "text-text-muted" } as const;

/**
 * Сводка — первый экран панели: что ждёт того, кто смотрит, как идёт
 * сегодня против вчера к тому же часу и две недели по суткам. Обновляется
 * сама раз в минуту, пока открыта: это экран, на который смотрят во время
 * поста или стрима.
 */
export function OverviewScreen() {
  const { state, reload } = useApi(() => fetchOverview(api), []);

  useEffect(() => {
    const timer = window.setInterval(reload, OVERVIEW_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const overview = state.data;

  return (
    <div className="flex flex-col gap-4">
      <Attention overview={overview} />
      <Today overview={overview} onReload={reload} />
      <Series overview={overview} />
    </div>
  );
}

function Attention({ overview }: { overview: Overview }) {
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

function Today({ overview, onReload }: { overview: Overview; onReload: () => void }) {
  const { today, yesterday } = overview;
  return (
    <Panel
      title={`Сегодня, ${dayTitle(overview.day)} — с полуночи по Москве`}
      help={HELP.overview.today}
      actions={
        <span className="flex items-center gap-3">
          <span className="text-xs text-text-muted">обновлено в {formatTime(overview.at)}, само — раз в минуту</span>
          <Button onClick={onReload}>Обновить</Button>
        </span>
      }
    >
      <div className={`grid gap-2 ${today.revenue === null ? "grid-cols-3" : "grid-cols-2 xl:grid-cols-4"}`}>
        <Tile title="Новые игроки" help={HELP.overview.newPlayers} value={newAccounts(today)} before={newAccounts(yesterday)} sub={sourcesLine(today)} />
        <Tile title="Играли" help={HELP.overview.active} value={today.active} before={yesterday.active} sub={`запусков ${formatNumber(today.sessions)}`} />
        <Tile
          title="Забеги"
          help={HELP.overview.runs}
          value={today.runs.finished}
          before={yesterday.runs.finished}
          sub={`игроков ${formatNumber(today.runs.players)}${today.runs.medianSurvivalSec === null ? "" : ` · медиана ${formatDuration(today.runs.medianSurvivalSec)}`}`}
        />
        {today.revenue === null ? null : (
          <Tile
            title="Звёзды"
            help={HELP.overview.stars}
            value={today.revenue.stars}
            before={yesterday.revenue?.stars ?? 0}
            sub={`покупок ${formatNumber(today.revenue.purchases)}${today.revenue.refunds === 0 ? "" : ` · возвратов ${formatNumber(today.revenue.refunds)}`}`}
          />
        )}
      </div>
      <FunnelLine overview={overview} />
    </Panel>
  );
}

function Tile({ title, help, value, before, sub }: { title: string; help: string; value: number; before: number; sub: ReactNode }) {
  const delta = versusYesterday(value, before);
  return (
    <div className="flex flex-col gap-0.5 rounded-sm border border-border bg-surface-sunken px-3 py-2.5">
      <span className="flex items-center gap-1 text-xs text-text-muted">
        {title}
        <Help text={help} />
      </span>
      <span className="flex items-baseline gap-2">
        <span className="font-display text-2xl font-semibold tabular-nums">{formatNumber(value)}</span>
        <span className={`text-xs ${TONE_CLASS[delta.tone]}`}>{delta.text}</span>
      </span>
      <span className="text-xs text-text-muted">{sub}</span>
    </div>
  );
}

/** Шаги воронки за сегодня одной строкой: где новички остановились. */
function FunnelLine({ overview }: { overview: Overview }) {
  const { funnel } = overview.today;
  const steps: [string, number][] = [
    ["вошли в бота", funnel.entered],
    ["открыли игру", funnel.appOpened],
    ["первый забег", funnel.firstRun],
    ["пятый забег", funnel.runs5],
    ["первая покупка", funnel.firstPurchase],
  ];
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
      <span>Вехи сегодня:</span>
      {steps.map(([title, count], index) => (
        <span key={title} className="whitespace-nowrap">
          {index === 0 ? null : <span className="mr-2 text-text-disabled">→</span>}
          {title} <span className="text-text tabular-nums">{formatNumber(count)}</span>
        </span>
      ))}
      <span className="whitespace-nowrap">
        · вернулись на D1 <span className="text-text tabular-nums">{formatNumber(funnel.returnedD1)}</span>, на D7 <span className="text-text tabular-nums">{formatNumber(funnel.returnedD7)}</span>
      </span>
    </p>
  );
}

function Series({ overview }: { overview: Overview }) {
  const days = overview.series.length;
  const of = (pick: (point: Overview["series"][number]) => number | null) => overview.series.map((point) => ({ day: point.day, count: pick(point) ?? 0 }));
  const hasStars = overview.series.every((point) => point.stars !== null);
  return (
    <Panel title={`За ${String(days)} дней`} help={HELP.overview.series}>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Chart title="Новые игроки">
          <DailyBars daily={of((point) => point.newAccounts)} what="новых игроков" days={days} />
        </Chart>
        <Chart title="Играли">
          <DailyBars daily={of((point) => point.active)} what="игроков" days={days} />
        </Chart>
        <Chart title="Забеги">
          <DailyBars daily={of((point) => point.finishedRuns)} what="забегов" days={days} />
        </Chart>
        {hasStars ? (
          <Chart title="Звёзды">
            <DailyBars daily={of((point) => point.stars)} what="звёзд" days={days} />
          </Chart>
        ) : null}
      </div>
    </Panel>
  );
}

function Chart({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}
