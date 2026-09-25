import { api } from "../../app";
import { compactJson, fetchAudit } from "../../api/roles";
import { formatDateTime } from "../../format";
import { Button, DataTable, ErrorNotice, Loading, Panel } from "../../ui/kit";
import { useApi } from "../../ui/use-api";

/**
 * Журнал действий (docs/29-admin-panel.md §3.4): только чтение — журнал из
 * панели не редактируется. Свежие первыми.
 */
export function AuditScreen() {
  const { state, reload } = useApi(() => fetchAudit(api), []);
  return (
    <Panel title="Журнал аудита" actions={<Button onClick={reload}>Обновить</Button>}>
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok" ? (
        <DataTable
          rows={state.data.entries}
          rowKey={(entry) => entry.entryId}
          empty="Журнал пуст"
          columns={[
            { title: "Когда", render: (entry) => formatDateTime(entry.createdAt) },
            { title: "Кто", render: (entry) => (entry.actorAccountId === null ? "система" : <code className="text-xs">{entry.actorAccountId.slice(0, 8)}</code>) },
            { title: "Действие", render: (entry) => entry.action },
            { title: "Над чем", render: (entry) => (entry.target === null || entry.target === undefined ? "—" : <code className="text-xs">{entry.target.slice(0, 36)}</code>) },
            { title: "Было", render: (entry) => <span className="text-xs text-text-muted">{compactJson(entry.before)}</span> },
            { title: "Стало", render: (entry) => <span className="text-xs">{compactJson(entry.after)}</span> },
          ]}
        />
      ) : null}
    </Panel>
  );
}
