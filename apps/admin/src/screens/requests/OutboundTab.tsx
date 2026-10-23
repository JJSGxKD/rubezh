import { useState } from "react";
import type { ApiError } from "../../api/client";
import {
  callOutcome,
  fetchOutboundCalls,
  fetchOutboundSummary,
  formatLatency,
  formatShare,
  viaLabel,
  type OutboundCall,
  type RequestPeriod,
} from "../../api/requests";
import { formatDateTime, formatNumber } from "../../format";
import { api } from "../../services";
import { HELP } from "../../ui/help";
import { Badge, Button, DataTable, ErrorNotice, Field, Loading, Panel, Select } from "../../ui/kit";
import { useApi } from "../../ui/use-api";

/**
 * Исходящие вызовы сервера: сверху сводка по сервисам за период, ниже —
 * последние вызовы с фильтрами по сервису и «только ошибки». Сводку читает
 * база точно (медиана и p95 по каждому вызову), а не по корзинам.
 */
export function OutboundTab({ period }: { period: RequestPeriod }) {
  const summary = useApi(() => fetchOutboundSummary(api, period), [period]);
  const services = summary.state.status === "ok" ? summary.state.data.services.map((row) => row.service) : [];

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Сервисы" help={HELP.requests.outbound} actions={<Button onClick={summary.reload}>Обновить</Button>}>
        {summary.state.status === "loading" ? <Loading /> : null}
        {summary.state.status === "error" ? <ErrorNotice error={summary.state.error} onRetry={summary.reload} /> : null}
        {summary.state.status === "ok" ? (
          <DataTable
            rows={summary.state.data.services}
            rowKey={(row) => row.service}
            empty="За этот период вызовов не было"
            columns={[
              { title: "Сервис", render: (row) => <span className="font-medium">{row.service}</span> },
              { title: "Вызовов", align: "right", render: (row) => formatNumber(row.count) },
              {
                title: "Ошибок",
                align: "right",
                render: (row) => (row.errors === 0 ? "0" : <span className="text-danger">{`${formatNumber(row.errors)} · ${formatShare(row.errorRate)}`}</span>),
              },
              { title: "Медиана", align: "right", render: (row) => formatLatency(row.median) },
              { title: "p95", align: "right", render: (row) => formatLatency(row.p95) },
              { title: "Через прокси", align: "right", render: (row) => (row.viaProxy === 0 ? "—" : formatNumber(row.viaProxy)) },
            ]}
          />
        ) : null}
      </Panel>
      <Calls key={period} period={period} services={services} />
    </div>
  );
}

type More = ApiError | "loading" | null;

/** Таблица вызовов листается курсором: строк тысячи, смотрят свежие. */
function Calls({ period, services }: { period: RequestPeriod; services: readonly string[] }) {
  const [service, setService] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [extra, setExtra] = useState<OutboundCall[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [more, setMore] = useState<More>(null);
  const { state, reload } = useApi(() => fetchOutboundCalls(api, { period, service, errorsOnly }), [period, service, errorsOnly]);

  const reset = () => {
    setExtra([]);
    setNext(undefined);
    setMore(null);
  };

  const first = state.status === "ok" ? state.data : null;
  const rows = first === null ? [] : [...first.calls, ...extra];
  // Курсор последней страницы: пока «ещё» не нажимали, он в первом ответе.
  const cursor = next === undefined ? (first?.next ?? null) : next;

  const loadMore = async () => {
    if (cursor === null) return;
    setMore("loading");
    const result = await fetchOutboundCalls(api, { period, service, errorsOnly, before: cursor });
    if (!result.ok) return setMore(result.error);
    setMore(null);
    setExtra((current) => [...current, ...result.data.calls]);
    setNext(result.data.next);
  };

  return (
    <Panel
      title="Последние вызовы"
      actions={
        <Button
          onClick={() => {
            reset();
            reload();
          }}
        >
          Обновить
        </Button>
      }
    >
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Сервис">
          <Select
            value={service}
            onChange={(event) => {
              reset();
              setService(event.target.value);
            }}
          >
            <option value="">все</option>
            {services.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(event) => {
              reset();
              setErrorsOnly(event.target.checked);
            }}
          />
          только ошибки
        </label>
      </div>
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {first === null ? null : (
        <div className="flex flex-col gap-3">
          <DataTable
            rows={rows}
            rowKey={(row) => row.id}
            empty={errorsOnly ? "Ошибок за этот период нет" : "За этот период вызовов не было"}
            columns={[
              { title: "Путь", primary: true, render: (row) => <span className="break-all font-mono text-xs">{`${row.method} ${row.host}${row.path}`}</span> },
              { title: "Время", render: (row) => formatDateTime(row.at) },
              { title: "Сервис", render: (row) => row.service },
              { title: "Итог", render: (row) => <Badge tone={row.ok ? "success" : "danger"}>{callOutcome(row)}</Badge> },
              { title: "Заняло", align: "right", render: (row) => formatLatency({ ms: row.durationMs, atLeast: false }) },
              { title: "Как", render: (row) => viaLabel(row.via) },
              { title: "Попытка", align: "right", render: (row) => String(row.attempt) },
            ]}
          />
          {more !== null && more !== "loading" ? <ErrorNotice error={more} onRetry={() => void loadMore()} /> : null}
          {cursor === null ? null : (
            <div>
              <Button disabled={more === "loading"} onClick={() => void loadMore()}>
                {more === "loading" ? "Загрузка…" : "Раньше"}
              </Button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
