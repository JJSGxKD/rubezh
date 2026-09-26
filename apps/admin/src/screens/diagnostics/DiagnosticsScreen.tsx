import { useState } from "react";
import { api } from "../../services";
import type { ApiError } from "../../api/client";
import { compactJson } from "../../api/roles";
import { fetchReport, fetchReports, formatBytes, prettyJson, REPORTS_PAGE, type ReportFilter, type ReportRow } from "../../api/diagnostics";
import { formatDateTime } from "../../format";
import { Badge, Button, DataTable, ErrorNotice, Field, Input, KeyValue, Loading, Panel, Select } from "../../ui/kit";
import { navigate } from "../../ui/router";
import { saveFile } from "../../ui/save-file";
import { useApi } from "../../ui/use-api";

/**
 * Отчёты диагностики (docs/28-diagnostics.md): стресс-тесты и записи забегов с
 * устройств тестеров. Список листается курсором «раньше»: отчётов тысячи, а
 * смотрят свежие.
 */
export function DiagnosticsScreen({ id }: { id: string | null }) {
  return id === null ? <ReportList /> : <ReportView key={id} reportId={id} />;
}

type Page = { status: "loading" } | { status: "ok"; rows: ReportRow[]; more: boolean } | { status: "error"; error: ApiError };

function ReportList() {
  const [filter, setFilter] = useState<ReportFilter>({});
  const [draft, setDraft] = useState<ReportFilter>({});
  const [pages, setPages] = useState<ReportRow[]>([]);
  const [loadingMore, setLoadingMore] = useState<ApiError | "loading" | null>(null);
  const { state, reload } = useApi(() => fetchReports(api, filter), [filter.kind, filter.platform, filter.appVersion]);

  const first: Page = state.status === "ok" ? { status: "ok", rows: state.data.reports, more: state.data.reports.length === REPORTS_PAGE } : state;
  const rows = first.status === "ok" ? [...first.rows, ...pages] : [];

  const apply = () => {
    setPages([]);
    setFilter({ kind: draft.kind, platform: draft.platform, appVersion: draft.appVersion?.trim() || undefined });
  };

  const more = async () => {
    const last = rows[rows.length - 1];
    if (last === undefined) return;
    setLoadingMore("loading");
    const result = await fetchReports(api, { ...filter, before: last.receivedAt });
    if (!result.ok) return setLoadingMore(result.error);
    setLoadingMore(null);
    setPages((current) => [...current, ...result.data.reports]);
  };

  const lastPageFull = pages.length === 0 ? first.status === "ok" && first.more : pages.length % REPORTS_PAGE === 0;

  return (
    <Panel title="Отчёты диагностики" actions={<Button onClick={() => { setPages([]); reload(); }}>Обновить</Button>}>
      <div className="mb-4 flex items-end gap-2">
        <Field label="Вид">
          <Select value={draft.kind ?? ""} onChange={(event) => setDraft({ ...draft, kind: event.target.value === "" ? undefined : (event.target.value as "bench" | "run") })}>
            <option value="">все</option>
            <option value="bench">стресс-тест</option>
            <option value="run">запись забега</option>
          </Select>
        </Field>
        <Field label="Площадка">
          <Select value={draft.platform ?? ""} onChange={(event) => setDraft({ ...draft, platform: event.target.value === "" ? undefined : event.target.value })}>
            <option value="">все</option>
            {["telegram", "max", "vk", "web"].map((platform) => (
              <option key={platform}>{platform}</option>
            ))}
          </Select>
        </Field>
        <Field label="Версия">
          <Input value={draft.appVersion ?? ""} onChange={(event) => setDraft({ ...draft, appVersion: event.target.value })} placeholder="0.5.0" className="w-32" />
        </Field>
        <Button tone="primary" onClick={apply}>
          Показать
        </Button>
      </div>
      {first.status === "loading" ? <Loading /> : null}
      {first.status === "error" ? <ErrorNotice error={first.error} onRetry={reload} /> : null}
      {first.status === "ok" ? (
        <div className="flex flex-col gap-3">
          <DataTable
            rows={rows}
            rowKey={(row) => row.reportId}
            onRowClick={(row) => navigate({ section: "diagnostics", id: row.reportId })}
            empty="Отчётов нет"
            columns={[
              { title: "Получен", render: (row) => formatDateTime(row.receivedAt) },
              { title: "Вид", render: (row) => <Badge tone={row.kind === "bench" ? "info" : "neutral"}>{row.kind === "bench" ? "стресс-тест" : "забег"}</Badge> },
              { title: "Версия", render: (row) => row.appVersion },
              { title: "Площадка", render: (row) => row.platform },
              { title: "Тестер", render: (row) => row.platformUserId ?? "скрыт" },
              { title: "Итог", render: (row) => <span className="text-xs text-text-muted">{compactJson(row.summary, 90)}</span> },
              { title: "Размер", render: (row) => formatBytes(row.sizeBytes), align: "right" },
            ]}
          />
          {loadingMore !== null && loadingMore !== "loading" ? <ErrorNotice error={loadingMore} onRetry={() => void more()} /> : null}
          {lastPageFull ? (
            <div>
              <Button disabled={loadingMore === "loading"} onClick={() => void more()}>
                {loadingMore === "loading" ? "Загрузка…" : "Раньше"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

function ReportView({ reportId }: { reportId: string }) {
  const { state, reload } = useApi(() => fetchReport(api, reportId), [reportId]);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button onClick={() => navigate({ section: "diagnostics", id: null })}>← К списку</Button>
      </div>
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok" ? (
        <>
          <Panel
            title={state.data.kind === "bench" ? "Стресс-тест" : "Запись забега"}
            actions={
              <Button onClick={() => saveFile(new Blob([JSON.stringify(state.data, null, 2)], { type: "application/json" }), `report-${state.data.reportId}.json`)}>
                Скачать JSON
              </Button>
            }
          >
            <KeyValue
              items={[
                ["Отчёт", <code className="text-xs">{state.data.reportId}</code>],
                ["Схема", state.data.schemaVersion ?? "—"],
                ["Версия", state.data.appVersion],
                ["Контент", state.data.contentHash ?? "—"],
                ["Площадка", state.data.platform],
                ["Тестер", state.data.platformUserId ?? "скрыт — нет права на персональные данные"],
                ["Установка", state.data.installId ?? "—"],
                ["Снят", formatDateTime(state.data.occurredAt)],
                ["Получен", formatDateTime(state.data.receivedAt)],
                ["Размер", formatBytes(state.data.sizeBytes)],
              ]}
            />
          </Panel>
          <JsonPanel title="Итог" value={state.data.summary} />
          <JsonPanel title="Устройство" value={state.data.device} />
          <JsonPanel title="Отчёт целиком" value={state.data.payload} />
        </>
      ) : null}
    </div>
  );
}

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  const { text, truncated } = prettyJson(value);
  return (
    <Panel title={title}>
      <pre className="max-h-96 overflow-auto rounded-sm bg-surface-sunken p-3 text-xs">{text}</pre>
      {truncated ? <p className="mt-2 text-xs text-text-muted">Показано начало — целиком в «Скачать JSON».</p> : null}
    </Panel>
  );
}
