import { useState, type FormEvent } from "react";
import { api } from "../../app";
import type { ApiError } from "../../api/client";
import { FLAG_PLATFORMS, fetchFlags, flagProblem, flagReach, removeFlag, saveFlag, type FlagInput, type FlagRow } from "../../api/flags";
import { formatDateTime } from "../../format";
import { Badge, Button, DataTable, ErrorNotice, Field, Input, Loading, Notice, Panel } from "../../ui/kit";
import { useApi } from "../../ui/use-api";

type Outcome = { tone: "success"; text: string } | { tone: "danger"; error: ApiError } | null;

const EMPTY: FlagInput = { key: "", enabled: false, platforms: [], percent: 100, note: "" };

function toInput(flag: FlagRow): FlagInput {
  return { key: flag.key, enabled: flag.enabled, platforms: [...flag.platforms], percent: flag.percent, note: flag.note ?? "" };
}

/**
 * Флаги функций: рискованное прячется за флагом на сервере и выключается
 * сразу, без модерации клиента (docs/09-ci-cd.md §11). Выкат — по площадкам
 * и доле игроков; доля устойчивая: расширение не выключает уже попавших.
 */
export function FlagsScreen() {
  const { state, reload } = useApi(() => fetchFlags(api), []);
  const [input, setInput] = useState<FlagInput>(EMPTY);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const problem = flagProblem(input);

  const apply = async (next: FlagInput, done: string): Promise<boolean> => {
    setPending(true);
    const result = await saveFlag(api, next);
    setPending(false);
    if (!result.ok) {
      setOutcome({ tone: "danger", error: result.error });
      return false;
    }
    setOutcome({ tone: "success", text: done });
    reload();
    return true;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem !== null) return;
    if (!(await apply(input, `Флаг ${input.key} сохранён: ${flagReach(input)}`))) return;
    setInput(EMPTY);
    setEditing(false);
  };

  const remove = async (key: string) => {
    setPending(true);
    const result = await removeFlag(api, key);
    setPending(false);
    setRemoving(null);
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    setOutcome({ tone: "success", text: `Флаг ${key} снят — функция выключена у всех` });
    reload();
  };

  const togglePlatform = (platform: (typeof FLAG_PLATFORMS)[number]) =>
    setInput((current) => ({
      ...current,
      platforms: current.platforms.includes(platform) ? current.platforms.filter((item) => item !== platform) : [...current.platforms, platform],
    }));

  return (
    <div className="flex flex-col gap-4">
      <Panel title={editing ? `Флаг ${input.key}` : "Новый флаг"}>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Ключ" hint="его читает игра; латиница, точка, дефис">
              <Input value={input.key} disabled={editing} onChange={(event) => setInput({ ...input, key: event.target.value.trim().toLowerCase() })} placeholder="shop.v2" maxLength={64} />
            </Field>
            <Field label="Доля игроков, %">
              <Input type="number" min={0} max={100} step={1} value={input.percent} onChange={(event) => setInput({ ...input, percent: Number(event.target.value) })} className="w-24" />
            </Field>
            <Field label="Заметка">
              <Input value={input.note} onChange={(event) => setInput({ ...input, note: event.target.value })} maxLength={200} className="w-72" />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={input.enabled} onChange={(event) => setInput({ ...input, enabled: event.target.checked })} />
              Включён
            </label>
            <span className="text-text-muted">Площадки (ни одной — все):</span>
            {FLAG_PLATFORMS.map((platform) => (
              <label key={platform} className="flex items-center gap-1">
                <input type="checkbox" checked={input.platforms.includes(platform)} onChange={() => togglePlatform(platform)} />
                {platform}
              </label>
            ))}
          </div>
          <p className="text-sm text-text-muted">Получат: {flagReach(input)}</p>
          <div className="flex gap-2">
            <Button tone="primary" type="submit" disabled={problem !== null || pending}>
              Сохранить
            </Button>
            {editing ? (
              <Button
                onClick={() => {
                  setInput(EMPTY);
                  setEditing(false);
                }}
              >
                Отмена
              </Button>
            ) : null}
          </div>
          {problem !== null && input.key !== "" ? <Notice tone="info">{problem}</Notice> : null}
        </form>
        {outcome === null ? null : <div className="mt-3">{outcome.tone === "success" ? <Notice tone="success">{outcome.text}</Notice> : <Notice>{outcome.error.message}</Notice>}</div>}
      </Panel>
      <Panel title="Флаги" actions={<Button onClick={reload}>Обновить</Button>}>
        {state.status === "loading" ? <Loading /> : null}
        {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
        {state.status === "ok" ? (
          <DataTable
            rows={state.data.flags}
            rowKey={(row) => row.key}
            empty="Флагов ещё нет"
            columns={[
              { title: "Ключ", render: (row) => <code className="text-xs">{row.key}</code> },
              { title: "Состояние", render: (row) => (row.enabled ? <Badge tone="success">включён</Badge> : <Badge>выключен</Badge>) },
              { title: "Получают", render: (row) => flagReach(row) },
              { title: "Заметка", render: (row) => row.note ?? "—" },
              { title: "Изменён", render: (row) => formatDateTime(row.updatedAt) },
              {
                title: "",
                render: (row) =>
                  removing === row.key ? (
                    <div className="flex gap-2">
                      <Button tone="danger" disabled={pending} onClick={() => void remove(row.key)}>
                        Да, снять
                      </Button>
                      <Button onClick={() => setRemoving(null)}>Отмена</Button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <Button
                        tone={row.enabled ? "danger" : "secondary"}
                        disabled={pending}
                        onClick={() => void apply({ ...toInput(row), enabled: !row.enabled }, row.enabled ? `Флаг ${row.key} выключен` : `Флаг ${row.key} включён: ${flagReach({ ...row, enabled: true })}`)}
                      >
                        {row.enabled ? "Выключить" : "Включить"}
                      </Button>
                      <Button
                        onClick={() => {
                          setInput(toInput(row));
                          setEditing(true);
                        }}
                      >
                        Изменить
                      </Button>
                      <Button onClick={() => setRemoving(row.key)}>Снять</Button>
                    </div>
                  ),
              },
            ]}
          />
        ) : null}
      </Panel>
    </div>
  );
}
