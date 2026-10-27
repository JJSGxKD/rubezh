import { useEffect, useState } from "react";
import { OVERVIEW_REFRESH_MS, fetchOverview, newAccounts, parsePeriod, periodTitle, shiftDay, sourcesLine, type Overview, type OverviewDays } from "../../api/overview";
import { completionPct } from "../../api/overview";
import { formatDuration, formatNumber, formatTime } from "../../format";
import { api } from "../../services";
import { DailyBars } from "../../ui/daily-bars";
import { HELP } from "../../ui/help";
import { Button, ErrorNotice, Loading, Panel } from "../../ui/kit";
import { useApi } from "../../ui/use-api";
import { AdsPanel, Attention, Chart, FunnelBars, PeriodSwitch, Tile } from "./overview-parts";

const PERIOD_KEY = "admin.overview.days";

/** Хранилище может не отвечать (приватный режим) — тогда выбор не помнится, но экран работает. */
function storedPeriod(): OverviewDays {
  try {
    return parsePeriod(window.localStorage.getItem(PERIOD_KEY));
  } catch {
    return 1;
  }
}

function rememberPeriod(days: OverviewDays): void {
  try {
    window.localStorage.setItem(PERIOD_KEY, String(days));
  } catch {
    // Не запомнится — не страшно.
  }
}

const TILE_COLUMNS = { 3: "lg:grid-cols-3", 4: "lg:grid-cols-4", 5: "lg:grid-cols-5" } as const;

/**
 * Сводка — первый экран панели: что ждёт того, кто смотрит, как идёт период
 * против прошлого такой же длины, реклама по местам и ряд по суткам.
 * Обновляется сама раз в минуту, пока открыта: это экран, на который смотрят
 * во время поста или стрима.
 */
export function OverviewScreen() {
  const [days, setDays] = useState<OverviewDays>(storedPeriod);
  const { state, reload } = useApi(() => fetchOverview(api, days), [days]);

  useEffect(() => {
    const timer = window.setInterval(reload, OVERVIEW_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  const choose = (next: OverviewDays) => {
    rememberPeriod(next);
    setDays(next);
  };

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;
  const overview = state.data;

  return (
    <div className="flex flex-col gap-4">
      <Attention overview={overview} />
      <Today overview={overview} days={days} onPeriod={choose} onReload={reload} />
      {overview.ads === null ? null : <AdsPanel ads={overview.ads} days={days} />}
      <Series overview={overview} />
    </div>
  );
}

function Today({ overview, days, onPeriod, onReload }: { overview: Overview; days: OverviewDays; onPeriod: (days: OverviewDays) => void; onReload: () => void }) {
  const { today, yesterday, ads } = overview;
  const tiles = 3 + (today.revenue === null ? 0 : 1) + (ads === null ? 0 : 1);
  const adsPct = ads === null ? null : completionPct(ads.now);
  return (
    <Panel
      title={periodTitle(days, shiftDay(overview.day, -(days - 1)), overview.day)}
      help={HELP.overview.today}
      actions={
        <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
          <PeriodSwitch value={days} onChange={onPeriod} />
          <span className="text-xs text-text-muted max-md:hidden">обновлено в {formatTime(overview.at)}, само — раз в минуту</span>
          <Button onClick={onReload}>Обновить</Button>
        </span>
      }
    >
      <div className={`grid grid-cols-2 gap-2 ${TILE_COLUMNS[tiles as 3 | 4 | 5] ?? "lg:grid-cols-5"}`}>
        <Tile title="Новые игроки" help={HELP.overview.newPlayers} value={newAccounts(today)} before={newAccounts(yesterday)} days={days} sub={sourcesLine(today)} />
        <Tile title="Играли" help={HELP.overview.active} value={today.active} before={yesterday.active} days={days} sub={`запусков ${formatNumber(today.sessions)}`} />
        <Tile
          title="Забеги"
          help={HELP.overview.runs}
          value={today.runs.finished}
          before={yesterday.runs.finished}
          days={days}
          sub={`игроков ${formatNumber(today.runs.players)}${today.runs.medianSurvivalSec === null ? "" : ` · медиана ${formatDuration(today.runs.medianSurvivalSec)}`}`}
        />
        {today.revenue === null ? null : (
          <Tile
            title="Звёзды"
            help={HELP.overview.stars}
            value={today.revenue.stars}
            before={yesterday.revenue?.stars ?? 0}
            days={days}
            sub={`покупок ${formatNumber(today.revenue.purchases)}${today.revenue.refunds === 0 ? "" : ` · возвратов ${formatNumber(today.revenue.refunds)}`}`}
          />
        )}
        {ads === null ? null : (
          <Tile
            title="Реклама"
            help={HELP.overview.ads}
            value={ads.now.completed}
            before={ads.before.completed}
            days={days}
            className="col-span-2 lg:col-span-1"
            sub={`${adsPct === null ? "показов нет" : `досмотрено ${String(adsPct)}%`} · наград ${formatNumber(ads.now.claimed)}`}
          />
        )}
      </div>
      <FunnelBars funnel={today.funnel} />
    </Panel>
  );
}

function Series({ overview }: { overview: Overview }) {
  const length = overview.series.length;
  const of = (pick: (point: Overview["series"][number]) => number | null) => overview.series.map((point) => ({ day: point.day, count: pick(point) ?? 0 }));
  const hasStars = overview.series.every((point) => point.stars !== null);
  const hasPurchases = overview.series.every((point) => point.purchases !== null);
  return (
    <Panel title={`За ${String(length)} дней`} help={HELP.overview.series}>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Chart title="Новые игроки">
          <DailyBars daily={of((point) => point.newAccounts)} what="новых игроков" days={length} />
        </Chart>
        <Chart title="Играли">
          <DailyBars daily={of((point) => point.active)} what="игроков" days={length} />
        </Chart>
        <Chart title="Забеги">
          <DailyBars daily={of((point) => point.finishedRuns)} what="забегов" days={length} />
        </Chart>
        {hasStars ? (
          <Chart title="Звёзды">
            <DailyBars daily={of((point) => point.stars)} what="звёзд" days={length} />
          </Chart>
        ) : null}
        {hasPurchases ? (
          <Chart title="Покупки">
            <DailyBars daily={of((point) => point.purchases)} what="покупок" days={length} />
          </Chart>
        ) : null}
        {overview.ads === null ? null : (
          <Chart title="Показы рекламы">
            <DailyBars daily={of((point) => point.adsCompleted)} what="показов" days={length} />
          </Chart>
        )}
      </div>
    </Panel>
  );
}
