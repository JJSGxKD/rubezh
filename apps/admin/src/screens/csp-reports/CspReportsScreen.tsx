import { useState } from "react";
import { fetchCspSummary, directiveGroup, hostTitle, sortEntries, type CspEntry } from "../../api/csp-reports";
import { api } from "../../services";
import { formatDateTime } from "../../format";
import { Button, DataTable, ErrorNotice, Field, Input, Loading, Notice, Panel, Select } from "../../ui/kit";
import { HELP } from "../../ui/help";
import { useApi } from "../../ui/use-api";

/**
 * Блокировки клиента (T-0156): что политика источников заблокировала в игре
 * у игроков. Только чтение: сводка устаревает сама через 30 суток, кнопки
 * «сбросить» нет. Порядок и фильтр — на клиенте, без нового запроса.
 */
export function CspReportsScreen() {
  const { state, reload } = useApi(() => fetchCspSummary(api), []);
  const [order, setOrder] = useState<"fresh" | "count">("fresh");
  const [host, setHost] = useState("");

  return (
    <Panel title="Заблокированные адреса клиента" help={HELP.csp.summary} actions={<Button onClick={reload}>Обновить</Button>}>
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok" ? <Summary entries={state.data.entries} overflow={state.data.overflow} maxEntries={state.data.maxEntries} order={order} setOrder={setOrder} host={host} setHost={setHost} /> : null}
    </Panel>
  );
}

function Summary({
  entries,
  overflow,
  maxEntries,
  order,
  setOrder,
  host,
  setHost,
}: {
  entries: CspEntry[];
  overflow: number;
  maxEntries: number;
  order: "fresh" | "count";
  setOrder: (order: "fresh" | "count") => void;
  host: string;
  setHost: (host: string) => void;
}) {
  const needle = host.trim().toLowerCase();
  const rows = sortEntries(
    entries.filter((entry) => needle === "" || entry.host.toLowerCase().includes(needle)),
    order,
  );
  const empty = entries.length === 0 ? "Заблокированных адресов пока нет. Либо блокировать нечего, либо клиент с отчётами ещё не выкачен." : "По фильтру ничего нет";

  return (
    <div className="flex flex-col gap-3">
      {overflow > 0 ? (
        <Notice tone="warning">
          Сводка заполнена ({maxEntries} хостов): ещё {overflow} отчётов не поместились. Новые хосты появятся, когда старые устареют.
        </Notice>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Порядок">
          <Select value={order} onChange={(event) => setOrder(event.target.value as "fresh" | "count")}>
            <option value="fresh">Сначала свежие</option>
            <option value="count">Сначала частые</option>
          </Select>
        </Field>
        <Field label="Хост содержит">
          <Input value={host} onChange={(event) => setHost(event.target.value)} placeholder="fonts" className="w-48" />
        </Field>
      </div>
      <DataTable
        rows={rows}
        rowKey={(row) => `${row.directive}|${row.host}`}
        empty={empty}
        columns={[
          {
            title: "Что заблокировано",
            render: (row) => (
              <span>
                {directiveGroup(row.directive)} <span className="font-mono text-xs text-text-muted">{row.directive}</span>
              </span>
            ),
          },
          { title: "Хост", render: (row) => <span className={hostTitle(row.host) === row.host ? "font-mono text-xs" : ""}>{hostTitle(row.host)}</span> },
          { title: "Раз", render: (row) => row.count, align: "right" },
          { title: "Последний раз", render: (row) => formatDateTime(row.lastAt) },
        ]}
      />
    </div>
  );
}
