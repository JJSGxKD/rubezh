import { useEffect } from "react";
import { fetchOnline, hasCounted, ONLINE_REFRESH_MS, onlineRows, type OnlineCounts, type OnlineSnapshot } from "../api/online";
import { api } from "../services";
import { formatDateTime, formatNumber, formatTime } from "../format";
import { HELP } from "../ui/help";
import { Button, DataTable, ErrorNotice, KeyValue, Loading, Notice, Panel } from "../ui/kit";
import { useApi } from "../ui/use-api";

/**
 * Онлайн (Р107, T-0148): сколько людей сейчас в приложении и в забеге по
 * площадкам, сколько играло сегодня и рекорд. Обновляется само раз в 15 секунд,
 * пока раздел открыт; сервер пересчитывает числа заданием раз в минуту, так
 * что чаще спрашивать нет смысла.
 */
export function OnlineScreen() {
  const { state, reload } = useApi(() => fetchOnline(api), []);

  useEffect(() => {
    const timer = window.setInterval(reload, ONLINE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  return (
    <div className="flex flex-col gap-4">
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok" ? <Snapshot snapshot={state.data} onReload={reload} /> : null}
    </div>
  );
}

function Snapshot({ snapshot, onReload }: { snapshot: OnlineSnapshot; onReload: () => void }) {
  const counted = hasCounted(snapshot);
  const rows = onlineRows(snapshot);
  return (
    <>
      {counted ? null : <Notice tone="warning">Пересчёта ещё не было: числа появятся в течение минуты после запуска сервера. Если не появляются — проверьте Redis.</Notice>}
      <Panel title="Онлайн по площадкам" help={HELP.online.platforms} actions={<Button onClick={onReload}>Обновить</Button>}>
        <DataTable
          rows={rows}
          rowKey={(row) => row.platform}
          columns={[
            { title: "Площадка", render: (row) => row.title },
            { title: "В приложении", render: (row) => formatNumber(row.counts.app), align: "right", help: HELP.online.app },
            { title: "В забеге", render: (row) => formatNumber(row.counts.run), align: "right", help: HELP.online.run },
            { title: "Сегодня", render: (row) => formatNumber(row.counts.today), align: "right", help: HELP.online.today },
          ]}
        />
        <Total total={snapshot.total} />
      </Panel>
      <Panel title="Рекорд" help={HELP.online.peak}>
        {snapshot.peak === null ? (
          <p className="text-sm text-text-muted">Рекорда пока нет: он появится с первым пересчётом.</p>
        ) : (
          <KeyValue
            items={[
              ["Одновременно в приложении", formatNumber(snapshot.peak.value)],
              ["Когда", formatDateTime(snapshot.peak.at)],
            ]}
          />
        )}
        {counted ? <p className="mt-3 text-xs text-text-muted">Числа посчитаны в {formatTime(snapshot.at)}.</p> : null}
      </Panel>
    </>
  );
}

/** Итог — отдельной строкой под таблицей: сумма по площадкам, а не ещё одна площадка. */
function Total({ total }: { total: OnlineCounts }) {
  return (
    <p className="mt-3 border-t border-border pt-3 text-sm">
      <span className="font-semibold">Итого:</span> {formatNumber(total.app)} в приложении · {formatNumber(total.run)} в забеге · {formatNumber(total.today)} сегодня
    </p>
  );
}
