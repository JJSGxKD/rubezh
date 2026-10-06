import { useEffect, useState } from "react";
import { api } from "../../services";
import type { ApiError } from "../../api/client";
import {
  SETTING_PLACEHOLDER,
  SOURCE_TITLES,
  URL_MAX,
  fetchSettings,
  groupSettings,
  parseInteger,
  resetSetting,
  saveSetting,
  settingProblem,
  settingText,
  type SettingRow,
  type SettingValue,
} from "../../api/settings";
import { formatDateTime, plural } from "../../format";
import { Badge, Button, DataTable, ErrorNotice, Input, Loading, Notice, Panel } from "../../ui/kit";
import { HELP } from "../../ui/help";
import { useApi } from "../../ui/use-api";

type Outcome = { tone: "success"; text: string } | { tone: "danger"; error: ApiError } | null;

/** Якорь строки настройки: другие разделы ведут прямо к ней — `#/settings/ads.test-mode`. */
export function settingAnchor(key: string): string {
  return `setting-${key}`;
}

/**
 * Настройки без релиза: адреса чатов команды, переключатели и числа. Значение
 * отсюда сильнее окружения сервера и доходит до всех реплик за секунды;
 * «Сбросить» возвращает то, что записано в `.env` сервера.
 *
 * `focus` — ключ из адреса: раздел, который предупреждает о настройке,
 * ведёт к её строке, и её не нужно искать на длинной странице.
 */
export function SettingsScreen({ focus = null }: { focus?: string | null }) {
  const { state, reload } = useApi(() => fetchSettings(api), []);
  useEffect(() => {
    if (focus !== null && state.status === "ok") document.getElementById(settingAnchor(focus))?.scrollIntoView({ block: "center" });
  }, [focus, state.status]);
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
      (saved) => `«${saved.title}»: ${settingText(saved, saved.value)}`,
    );

  const reset = (row: SettingRow) =>
    run(
      () => resetSetting(api, row.key),
      (saved) => `«${saved.title}» снова из ${saved.source === "env" ? "окружения" : "умолчания"}: ${settingText(saved, saved.value)}`,
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
    const problem = settingProblem(row, editing.value);
    // Число уходит числом: в поле — текст, и пустое поле не должно стать нулём.
    const number = row.kind === "number" ? parseInteger(String(editing.value)) : null;
    const value = row.kind === "number" ? number : editing.value;
    const range = row.kind === "number" ? (row.range ?? null) : null;
    return (
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (problem === null && value !== null) void save(row, value);
        }}
      >
        <Input
          value={String(editing.value)}
          onChange={(event) => setEditing({ key: row.key, value: event.target.value })}
          placeholder={SETTING_PLACEHOLDER[row.kind]}
          maxLength={row.kind === "url" ? URL_MAX : row.kind === "number" ? 9 : 32}
          inputMode={row.kind === "number" ? "numeric" : undefined}
          className={row.kind === "url" ? "w-96" : row.kind === "number" ? "w-20 text-right tabular-nums" : "w-56"}
          autoFocus
        />
        {/* Единица и пределы рядом с полем; вышли за пределы — они же краснеют, без второй строки. */}
        {range === null ? null : (
          <span className={`text-xs ${number !== null && problem !== null ? "text-danger" : "text-text-muted"}`}>
            {plural(number ?? range.max, range.unit)} · от {range.min} до {range.max}
          </span>
        )}
        <Button tone="primary" type="submit" disabled={problem !== null || pending}>
          Сохранить
        </Button>
        <Button onClick={() => setEditing(null)}>Отмена</Button>
        {problem === null || (range !== null && number !== null) ? null : <span className="text-xs text-danger">{problem}</span>}
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
            <Panel key={group} title={group} help={HELP.settings.settings} actions={<Button onClick={reload}>Обновить</Button>}>
              <DataTable
                rows={rows}
                rowKey={(row) => row.key}
                columns={[
                  {
                    title: "Настройка",
                    render: (row) => (
                      <div id={settingAnchor(row.key)} className={`flex max-w-md flex-col gap-0.5 ${row.key === focus ? "-mx-2 rounded-sm bg-accent/10 px-2 py-1 ring-1 ring-accent/50" : ""}`}>
                        <span>{row.title}</span>
                        <span className="text-xs text-text-muted">{row.hint}</span>
                      </div>
                    ),
                  },
                  { title: "Значение", render: (row) => <code className="text-xs">{settingText(row, row.value)}</code> },
                  {
                    title: "Откуда",
                    render: (row) => (
                      <div className="flex flex-col gap-0.5">
                        <Badge tone={row.source === "base" ? "info" : "neutral"}>{SOURCE_TITLES[row.source]}</Badge>
                        {/* Что вернёт «Сбросить»: окружение, а если там пусто — умолчание из кода. */}
                        {row.source !== "base" ? null : row.envValue !== null ? (
                          <span className="text-xs text-text-muted">в окружении: {settingText(row, row.envValue)}</span>
                        ) : (
                          <span className="text-xs text-text-muted">по умолчанию: {settingText(row, row.fallback)}</span>
                        )}
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
