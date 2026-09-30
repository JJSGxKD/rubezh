import { useState, type FormEvent } from "react";
import type { ApiError } from "../../api/client";
import {
  CHANGELOG_KINDS,
  CHANGELOG_PLATFORMS,
  KIND_TITLES,
  TEXT_MAX,
  entryProblem,
  fetchChangelog,
  groupByVersion,
  platformsLabel,
  publishAudience,
  publishVersion,
  releaseState,
  removeEntry,
  saveEntry,
  sourcePr,
  type ChangelogEntry,
  type ChangelogPlatform,
  type EntryInput,
  type VersionGroup,
} from "../../api/changelog";
import { formatDateTime } from "../../format";
import { api } from "../../services";
import { useSession } from "../../state/use-session";
import { Badge, Button, ErrorNotice, Field, Input, Loading, Notice, Panel, Select, TextArea } from "../../ui/kit";
import { useApi } from "../../ui/use-api";

type Outcome = { tone: "success"; text: string } | { tone: "danger"; error: ApiError } | null;

const EMPTY: EntryInput = { version: "", kind: "added", platforms: [], text: "" };

function toInput(entry: ChangelogEntry): EntryInput {
  return { entryId: entry.entryId, version: entry.version, kind: entry.kind, platforms: [...entry.platforms], text: entry.text };
}

/**
 * Журнал обновлений (docs/35-stage4-plan.md WP31): что игроки увидят в
 * «Что нового». Строка — одно изменение с видом и площадками; черновик игроку
 * не виден. Строки из разделов «Для игроков» PR выкат заводит черновиками —
 * они помечены номером PR; правленную здесь строку выкат больше не трогает. Публикация версии — отдельной кнопкой и вторым нажатием: она
 * раздаёт уведомление в ленту всем игрокам площадок версии и пишет в бота
 * тем, кто не выключил.
 */
export function ChangelogScreen() {
  const { state, reload } = useApi(() => fetchChangelog(api), []);
  const canPublish = useSession((session) => session.view.status === "ready" && session.view.identity.permissions.includes("changelog.publish"));
  const [input, setInput] = useState<EntryInput>(EMPTY);
  const [original, setOriginal] = useState<ChangelogEntry | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const problem = entryProblem(input, original);
  const lockedByPublication = original !== null && original.publishedAt !== null;

  const reset = () => {
    setInput((current) => ({ ...EMPTY, version: current.version, platforms: current.platforms }));
    setOriginal(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem !== null) return;
    setPending(true);
    const result = await saveEntry(api, input);
    setPending(false);
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    setOutcome({ tone: "success", text: original === null ? `Строка добавлена в ${result.data.version} черновиком` : `Строка в ${result.data.version} сохранена` });
    reset();
    reload();
  };

  const remove = async (entry: ChangelogEntry) => {
    setPending(true);
    const result = await removeEntry(api, entry.entryId);
    setPending(false);
    setRemoving(null);
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    setOutcome({ tone: "success", text: entry.publishedAt === null ? "Черновик удалён" : "Строка удалена — игроки её больше не видят" });
    if (original?.entryId === entry.entryId) reset();
    reload();
  };

  const publish = async (group: VersionGroup) => {
    setPending(true);
    const result = await publishVersion(api, group.version);
    setPending(false);
    setPublishing(null);
    if (!result.ok) return setOutcome({ tone: "danger", error: result.error });
    setOutcome({ tone: "success", text: `Версия ${group.version} опубликована: строк — ${String(result.data.published)}, уведомление раздаётся` });
    reload();
  };

  const togglePlatform = (platform: ChangelogPlatform) =>
    setInput((current) => ({
      ...current,
      platforms: current.platforms.includes(platform) ? current.platforms.filter((item) => item !== platform) : [...current.platforms, platform],
    }));

  const edit = (entry: ChangelogEntry) => {
    setInput(toInput(entry));
    setOriginal(entry);
  };

  return (
    <div className="flex flex-col gap-4">
      <Panel title={original === null ? "Новая строка" : `Строка в ${original.version}`}>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Версия, X.Y.Z">
              <Input value={input.version} disabled={lockedByPublication} onChange={(event) => setInput({ ...input, version: event.target.value.trim() })} placeholder="0.6.0" maxLength={16} className="w-28" />
            </Field>
            <Field label="Вид">
              <Select value={input.kind} onChange={(event) => setInput({ ...input, kind: CHANGELOG_KINDS.find((kind) => kind === event.target.value) ?? "added" })}>
                {CHANGELOG_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_TITLES[kind]}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex flex-wrap items-center gap-3 pb-1.5 text-sm">
              <span className="text-text-muted">Площадки (ни одной — все):</span>
              {CHANGELOG_PLATFORMS.map((platform) => (
                <label key={platform} className="flex items-center gap-1">
                  <input type="checkbox" disabled={lockedByPublication} checked={input.platforms.includes(platform)} onChange={() => togglePlatform(platform)} />
                  {platform}
                </label>
              ))}
            </div>
          </div>
          <Field label={`Что изменилось — ${String(input.text.trim().length)} из ${String(TEXT_MAX)}`} hint="простой текст, одно изменение; игрок видит его как есть">
            <TextArea value={input.text} onChange={(event) => setInput({ ...input, text: event.target.value })} rows={3} maxLength={TEXT_MAX + 50} className="w-full max-w-2xl" />
          </Field>
          {lockedByPublication ? <Notice tone="info">Строка уже у игроков: меняются только текст и вид.</Notice> : null}
          <div className="flex gap-2">
            <Button tone="primary" type="submit" disabled={problem !== null || pending}>
              {original === null ? "Добавить черновиком" : "Сохранить"}
            </Button>
            {original === null ? null : <Button onClick={reset}>Отмена</Button>}
          </div>
          {/* После добавления поле текста пустое, а версия остаётся для следующей строки: подсказка — когда начали писать. */}
          {problem !== null && input.text.trim() !== "" ? <Notice tone="info">{problem}</Notice> : null}
        </form>
        {outcome === null ? null : <div className="mt-3">{outcome.tone === "success" ? <Notice tone="success">{outcome.text}</Notice> : <Notice>{outcome.error.message}</Notice>}</div>}
      </Panel>

      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ok" && state.data.entries.length === 0 ? <Notice tone="info">Журнал пуст — начните с первой строки выше.</Notice> : null}
      {state.status === "ok"
        ? groupByVersion(state.data.entries, state.data.releases).map((group) => (
            <Panel
              key={group.version}
              title={`Версия ${group.version}`}
              actions={
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-text-muted">
                    {releaseState(group.release)}
                    {group.release === null ? "" : ` · ${formatDateTime(group.release.doneAt ?? group.release.publishedAt)}`}
                  </span>
                  {group.drafts === 0 ? null : <Badge tone="warning">черновиков: {group.drafts}</Badge>}
                  {canPublish && group.drafts > 0 ? (
                    publishing === group.version ? (
                      <>
                        <span>Уведомление получат игроки: {publishAudience(group.entries)}. Опубликовать?</span>
                        <Button tone="primary" disabled={pending} onClick={() => void publish(group)}>
                          Да, опубликовать
                        </Button>
                        <Button onClick={() => setPublishing(null)}>Отмена</Button>
                      </>
                    ) : (
                      <Button tone="primary" disabled={pending} onClick={() => setPublishing(group.version)}>
                        Опубликовать
                      </Button>
                    )
                  ) : null}
                </div>
              }
            >
              <ul className="flex flex-col divide-y divide-border">
                {group.entries.map((entry) => (
                  <li key={entry.entryId} className="flex items-start gap-3 py-2">
                    <div className="flex w-56 shrink-0 flex-wrap gap-1">
                      <Badge tone={entry.kind === "added" ? "accent" : entry.kind === "fixed" ? "success" : "info"}>{KIND_TITLES[entry.kind]}</Badge>
                      <Badge>{platformsLabel(entry.platforms)}</Badge>
                      {entry.publishedAt === null ? <Badge tone="warning">черновик</Badge> : null}
                      {sourcePr(entry) === null ? null : <Badge tone="info">из PR #{sourcePr(entry)}</Badge>}
                    </div>
                    <p className="min-w-0 flex-1 whitespace-pre-line break-words text-sm">{entry.text}</p>
                    <div className="flex shrink-0 gap-2">
                      {removing === entry.entryId ? (
                        <>
                          <Button tone="danger" disabled={pending} onClick={() => void remove(entry)}>
                            Да, удалить
                          </Button>
                          <Button onClick={() => setRemoving(null)}>Отмена</Button>
                        </>
                      ) : (
                        <>
                          <Button onClick={() => edit(entry)}>Изменить</Button>
                          <Button onClick={() => setRemoving(entry.entryId)}>Удалить</Button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          ))
        : null}
    </div>
  );
}
