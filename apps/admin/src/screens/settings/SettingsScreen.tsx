import { useState } from "react";
import { api } from "../../services";
import type { ApiError } from "../../api/client";
import { SETTING_PLACEHOLDER, SOURCE_TITLES, URL_MAX, fetchSettings, groupSettings, resetSetting, saveSetting, settingProblem, settingText, type SettingRow, type SettingValue } from "../../api/settings";
import { formatDateTime } from "../../format";
import { Badge, Button, DataTable, ErrorNotice, Input, Loading, Notice, Panel } from "../../ui/kit";
import { useApi } from "../../ui/use-api";

type Outcome = { tone: "success"; text: string } | { tone: "danger"; error: ApiError } | null;

/**
 * Настройки без релиза: адреса чатов команды и переключатели. Значение
 * отсюда сильнее окружения сервера и доходит до всех реплик за секунды;
 * «Сбросить» возвращает то, что записано в `.env` сервера.
 */
export function SettingsScreen() {
  const { state, reload } = useApi(() => fetchSettings(api), []);
  const [editing, setEditing] = useState<{ key: string; value: SettingValue } | null>(null);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const run = async (action: () => ReturnType<typeof saveSetting>, done: (row: SettingRow) => string) => {
    setPending(true);
    const result = await action();
    setPending(false);
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    setOutcome({ tone: "success", text: done(result.data) });
    setEditing(null);
    reload();
  };

  const save = (row: SettingRow, value: SettingValue) =>
    run(
      () => saveSetting(api, row.key, value),
      (saved) => `«${saved.title}»: ${settingText(saved.kind, saved.value)}`,
    );

  const reset = (row: SettingRow) =>
    run(
      () => resetSetting(api, row.key),
      (saved) => `«${saved.title}» снова из ${saved.source === "env" ? "окружения" : "умолчания"}: ${settingText(saved.kind, saved.value)}`,
    );

  const editor = (row: SettingRow) => {
    if (row.kind === "boolean") {
      return (
        <Button tone={row.value === true ? "danger" : "secondary"} disabled={pending} onClick={() => void save(row, row.value !== true)}>
          {row.value === true ? "Выключить" : "Включить"}
        </Button>
      );
    }
    if (editing?.key !== row.key) {
      return (
        <Button disabled={pending} onClick={() => setEditing({ key: row.key, value: String(row.value) })}>
          Изменить
        </Button>
      );
    }
    const problem = settingProblem(row.kind, editing.value);
    return (
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (problem === null) void save(row, editing.value);
        }}
      >
        <Input
          value={String(editing.value)}
          onChange={(event) => setEditing({ key: row.key, value: event.target.value })}
          placeholder={SETTING_PLACEHOLDER[row.kind]}
          maxLength={row.kind === "url" ? URL_MAX : 32}
          className={row.kind === "url" ? "w-96" : "w-56"}
          autoFocus
        />
        <Button tone="primary" type="submit" disabled={problem !== null || pending}>
          Сохранить
        </Button>
        <Button onClick={() => setEditing(null)}>Отмена</Button>
        {problem === null ? null : <span className="text-xs text-danger">{problem}</span>}
      </form>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {outcome === null ? null : outcome.tone === "success" ? <Notice tone="success">{outcome.text}</Notice> : <Notice>{outcome.error.message}</Notice>}
      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok"
        ? groupSettings(state.data.settings).map(({ group, rows }) => (
            <Panel key={group} title={group} actions={<Button onClick={reload}>Обновить</Button>}>
              <DataTable
                rows={rows}
                rowKey={(row) => row.key}
                columns={[
                  {
                    title: "Настройка",
                    render: (row) => (
                      <div className="flex max-w-md flex-col gap-0.5">
                        <span>{row.title}</span>
                        <span className="text-xs text-text-muted">{row.hint}</span>
                      </div>
                    ),
                  },
                  { title: "Значение", render: (row) => <code className="text-xs">{settingText(row.kind, row.value)}</code> },
                  {
                    title: "Откуда",
                    render: (row) => (
                      <div className="flex flex-col gap-0.5">
                        <Badge tone={row.source === "base" ? "info" : "neutral"}>{SOURCE_TITLES[row.source]}</Badge>
                        {row.source === "base" ? <span className="text-xs text-text-muted">в окружении: {settingText(row.kind, row.envValue)}</span> : null}
                      </div>
                    ),
                  },
                  { title: "Изменена", render: (row) => (row.updatedAt === null ? "—" : formatDateTime(row.updatedAt)) },
                  {
                    title: "",
                    render: (row) => (
                      <div className="flex flex-wrap gap-2">
                        {editor(row)}
                        {row.source === "base" ? (
                          <Button disabled={pending} onClick={() => void reset(row)}>
                            Сбросить
                          </Button>
                        ) : null}
                      </div>
                    ),
                  },
                ]}
              />
            </Panel>
          ))
        : null}
    </div>
  );
}
