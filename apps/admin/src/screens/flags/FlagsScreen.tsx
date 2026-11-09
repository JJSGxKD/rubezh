import { useState, type FormEvent } from "react";
import { api } from "../../services";
import type { ApiError } from "../../api/client";
import { FLAG_PLATFORMS, fetchFlags, flagProblem, flagReach, removeFlag, saveFlag, type FlagInput, type FlagRow } from "../../api/flags";
import { formatDateTime } from "../../format";
import { FormDialog, isDirty } from "../../ui/form-dialog";
import { Badge, Button, DataTable, ErrorNotice, Field, FieldRow, Input, Loading, Notice, Panel } from "../../ui/kit";
import { HELP } from "../../ui/help";
import { useApi } from "../../ui/use-api";
import { hrefOf } from "../../routes";
import { useSession } from "../../state/use-session";

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
  // Сравнение долей живёт в «Воронке» — ссылка только тем, кому она открыта.
  const canCompare = useSession((session) => session.view.status === "ready" && session.view.identity.permissions.includes("analytics.gameplay.view"));
  const [input, setInput] = useState<FlagInput>(EMPTY);
  // Значения при открытии окна: по ним видно, тронул ли оператор форму.
  const [initial, setInitial] = useState<FlagInput>(EMPTY);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const problem = flagProblem(input);

  const openForm = (value: FlagInput, edit: boolean): void => {
    setInput(value);
    setInitial(value);
    setEditing(edit);
    setFormError(null);
    setOpen(true);
  };

  const closeForm = (): void => {
    setOpen(false);
    setEditing(false);
    setInput(EMPTY);
    setInitial(EMPTY);
    setFormError(null);
  };

  const apply = async (next: FlagInput, done: string, inDialog = false): Promise<boolean> => {
    setPending(true);
    const result = await saveFlag(api, next);
    setPending(false);
    if (!result.ok) {
      if (inDialog) setFormError(result.error.message);
      else setOutcome({ tone: "danger", error: result.error });
      return false;
    }
    setOutcome({ tone: "success", text: done });
    reload();
    return true;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem !== null) return;
    setFormError(null);
    if (!(await apply(input, `Флаг ${input.key} сохранён: ${flagReach(input)}`, true))) return;
    closeForm();
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
      {outcome === null ? null : outcome.tone === "success" ? <Notice tone="success">{outcome.text}</Notice> : <Notice>{outcome.error.message}</Notice>}
      <Panel
        title="Флаги"
        help={HELP.flags.flags}
        actions={
          <>
            <Button tone="primary" onClick={() => openForm(EMPTY, false)}>
              Новый флаг
            </Button>
            <Button onClick={reload}>Обновить</Button>
          </>
        }
      >
        {state.status === "loading" ? <Loading /> : null}
        {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
        {state.status === "ok" ? (
          <DataTable
            rows={state.data.flags}
            rowKey={(row) => row.key}
            empty="Флагов ещё нет — заведите кнопкой «Новый флаг»: он включает функцию на одной площадке или доле игроков"
            columns={[
              { title: "Ключ", render: (row) => <code className="text-xs">{row.key}</code> },
              { title: "Состояние", render: (row) => (row.enabled ? <Badge tone="success">включён</Badge> : <Badge>выключен</Badge>) },
              { title: "Получают", help: HELP.flags.reach, render: (row) => flagReach(row) },
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
                    <div className="flex flex-wrap justify-end gap-2 md:flex-nowrap">
                      <Button
                        tone={row.enabled ? "danger" : "secondary"}
                        disabled={pending}
                        onClick={() => void apply({ ...toInput(row), enabled: !row.enabled }, row.enabled ? `Флаг ${row.key} выключен` : `Флаг ${row.key} включён: ${flagReach({ ...row, enabled: true })}`)}
                      >
                        {row.enabled ? "Выключить" : "Включить"}
                      </Button>
                      <Button
                        onClick={() => openForm(toInput(row), true)}
                      >
                        Изменить
                      </Button>
                      <Button onClick={() => setRemoving(row.key)}>Снять</Button>
                      {canCompare ? (
                        <a className="self-center whitespace-nowrap text-sm text-accent hover:underline" href={hrefOf({ section: "funnel", id: row.key })}>
                          Сравнить доли
                        </a>
                      ) : null}
                    </div>
                  ),
              },
            ]}
          />
        ) : null}
      </Panel>
      <FormDialog
        open={open}
        title={editing ? `Флаг ${input.key}` : "Новый флаг"}
        dirty={isDirty(initial, input)}
        onClose={closeForm}
        footer={(requestClose) => (
          <>
            {formError === null ? null : <span className="mr-auto text-sm text-danger">{formError}</span>}
            <Button onClick={requestClose}>Отмена</Button>
            <Button tone="primary" type="submit" form="flag-form" disabled={problem !== null || pending} blockedBy={pending ? null : problem}>
              Сохранить
            </Button>
          </>
        )}
      >
        <form id="flag-form" onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
          <FieldRow>
            <Field label="Ключ" hint="его читает игра; латиница, точка, дефис">
              <Input value={input.key} disabled={editing} onChange={(event) => setInput({ ...input, key: event.target.value.trim().toLowerCase() })} placeholder="shop.v2" maxLength={64} />
            </Field>
            <Field label="Доля игроков, %" help={HELP.flags.percent}>
              <Input type="number" min={0} max={100} step={1} value={input.percent} onChange={(event) => setInput({ ...input, percent: Number(event.target.value) })} className="w-24" />
            </Field>
            <Field label="Заметка">
              <Input value={input.note} onChange={(event) => setInput({ ...input, note: event.target.value })} maxLength={200} className="w-72" />
            </Field>
          </FieldRow>
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
        </form>
      </FormDialog>
    </div>
  );
}
