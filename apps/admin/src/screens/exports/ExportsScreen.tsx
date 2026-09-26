import { useState } from "react";
import { api } from "../../services";
import type { ApiError } from "../../api/client";
import { formatBytes } from "../../api/diagnostics";
import { buildExport, EXPORT_SOURCES, EXPORT_STATUSES, fetchExports } from "../../api/exports";
import { periodFromDates } from "../../api/funnel";
import { formatDateTime, formatNumber } from "../../format";
import { Badge, Button, DataTable, ErrorNotice, Field, Input, Loading, Notice, Panel } from "../../ui/kit";
import { saveFile } from "../../ui/save-file";
import { useApi } from "../../ui/use-api";

/**
 * Выгрузки данных (docs/28-diagnostics.md §6): архив событий и отчётов за
 * период для разбора ИИ-агентом — тот же, что кнопкой в боте, но файлом
 * целиком, без предела Bot API. Каждая сборка — в журнале и в аудите.
 */
export function ExportsScreen() {
  const { state, reload } = useApi(() => fetchExports(api), []);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [building, setBuilding] = useState(false);
  const [outcome, setOutcome] = useState<{ tone: "success"; text: string } | { tone: "danger"; error: ApiError } | null>(null);

  const build = async () => {
    setBuilding(true);
    setOutcome(null);
    const result = await buildExport(api, periodFromDates(fromDate, toDate));
    setBuilding(false);
    reload();
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    saveFile(result.data.blob, result.data.fileName);
    setOutcome({ tone: "success", text: `Архив ${result.data.fileName} — ${formatBytes(result.data.blob.size)}` });
  };

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Собрать архив">
        <div className="flex flex-col gap-3">
          <div className="flex items-end gap-2">
            <Field label="С">
              <Input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
            </Field>
            <Field label="По (включительно)">
              <Input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
            </Field>
            <Button tone="primary" disabled={building} onClick={() => void build()}>
              {building ? "Собирается…" : "Собрать и скачать"}
            </Button>
          </div>
          <p className="text-xs text-text-muted">Пусто — последние тридцать дней. Не чаще трёх раз в десять минут: сборка нагружает базу.</p>
          {outcome === null ? null : outcome.tone === "success" ? <Notice tone="success">{outcome.text}</Notice> : <Notice>{outcome.error.message}</Notice>}
        </div>
      </Panel>
      <Panel title="Журнал выгрузок" actions={<Button onClick={reload}>Обновить</Button>}>
        {state.status === "loading" ? <Loading /> : null}
        {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
        {state.status === "ok" ? (
          <DataTable
            rows={state.data.exports}
            rowKey={(row) => row.exportId}
            empty="Выгрузок ещё не было"
            columns={[
              { title: "Когда", render: (row) => formatDateTime(row.createdAt) },
              { title: "Откуда", render: (row) => EXPORT_SOURCES[row.source] ?? row.source },
              { title: "Период", render: (row) => `${row.period.from === null ? "с начала" : formatDateTime(row.period.from)} — ${formatDateTime(row.period.to)}` },
              {
                title: "Статус",
                render: (row) => (
                  <Badge tone={row.status === "sent" ? "success" : row.status === "failed" ? "danger" : "info"}>{EXPORT_STATUSES[row.status] ?? row.status}</Badge>
                ),
              },
              { title: "Событий", render: (row) => formatNumber(row.events), align: "right" },
              { title: "Отчётов", render: (row) => formatNumber(row.reports), align: "right" },
              { title: "Размер", render: (row) => formatBytes(row.sizeBytes), align: "right" },
              { title: "Ошибка", render: (row) => row.error ?? "—" },
            ]}
          />
        ) : null}
      </Panel>
    </div>
  );
}
