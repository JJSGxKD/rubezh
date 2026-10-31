import { useState } from "react";
import { MODE_NOTES, PROXY_MODES, fetchModes, modeLabel, serviceTitle, setServiceMode, type ModeRow, type ProxyMode } from "../../api/proxies";
import { formatDateTime } from "../../format";
import { api } from "../../services";
import { HELP } from "../../ui/help";
import { Badge, DataTable, ErrorNotice, Loading, Panel, Select, type Column } from "../../ui/kit";
import { toast } from "../../ui/toast";
import { useApi } from "../../ui/use-api";

/**
 * Режим каждого сервиса клиента исходящих (docs/35-stage4-plan.md Р91):
 * сначала напрямую, только через прокси или только напрямую. Строки режима нет —
 * работает умолчание из кода; Bot API по умолчанию — только напрямую, чтобы токен
 * бота в адресе не уходил чужому серверу.
 */
export function ModesPanel({ canEdit }: { canEdit: boolean }) {
  const { state, reload } = useApi(() => fetchModes(api), []);
  const [saving, setSaving] = useState<string | null>(null);

  const change = async (row: ModeRow, mode: ProxyMode) => {
    if (mode === row.mode) return;
    setSaving(row.service);
    const result = await setServiceMode(api, row.service, mode);
    setSaving(null);
    if (!result.ok) return void toast.error(result.error.message);
    toast.success(`${serviceTitle(row.service)}: ${modeLabel(mode).toLowerCase()}`, { description: "Заработает в течение полуминуты — без перезапуска" });
    reload();
  };

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;

  const columns: Column<ModeRow>[] = [
    {
      title: "Сервис",
      primary: true,
      render: (row) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{serviceTitle(row.service)}</span>
          <code className="font-mono text-xs text-text-muted">{row.service}</code>
        </div>
      ),
    },
    {
      title: "Режим",
      render: (row) =>
        canEdit ? (
          <div className="flex flex-col gap-1">
            <Select value={row.mode} disabled={saving === row.service} onChange={(event) => void change(row, event.target.value as ProxyMode)} aria-label={`Режим: ${serviceTitle(row.service)}`}>
              {PROXY_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {modeLabel(mode)}
                </option>
              ))}
            </Select>
            <span className="text-xs text-text-muted">{MODE_NOTES[row.mode]}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            <span>{modeLabel(row.mode)}</span>
            <span className="text-xs text-text-muted">{MODE_NOTES[row.mode]}</span>
          </div>
        ),
    },
    {
      title: "Задан",
      render: (row) =>
        row.custom ? (
          <span className="flex flex-col gap-0.5">
            <Badge tone="info">В панели</Badge>
            {row.updatedAt === null ? null : <span className="text-xs text-text-muted">{formatDateTime(row.updatedAt)}</span>}
          </span>
        ) : (
          <span className="flex flex-col gap-0.5">
            <Badge>По умолчанию</Badge>
            {row.default === "direct_only" ? <span className="text-xs text-text-muted">токен бота в адресе</span> : null}
          </span>
        ),
    },
  ];

  return (
    <Panel title="Режимы сервисов" help={HELP.proxies.modes}>
      <DataTable columns={columns} rows={state.data.modes} rowKey={(row) => row.service} />
    </Panel>
  );
}
