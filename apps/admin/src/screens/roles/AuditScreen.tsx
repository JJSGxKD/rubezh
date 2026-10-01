import { useState, type MouseEvent, type ReactNode } from "react";
import {
  AUDIT_AREAS,
  NO_AUDIT_FILTER,
  actionTitle,
  auditChanges,
  auditMode,
  auditObject,
  auditValue,
  fetchAudit,
  fieldTitle,
  isKnownAction,
  prettyAudit,
  type AuditEntry,
  type AuditFilter,
} from "../../api/audit";
import type { ApiError } from "../../api/client";
import { formatDateTime } from "../../format";
import { hrefOf } from "../../routes";
import { api } from "../../services";
import { Dialog } from "../../ui/dialog";
import { HELP } from "../../ui/help";
import { Button, DataTable, ErrorNotice, KeyValue, Loading, Panel } from "../../ui/kit";
import { navigate } from "../../ui/router";
import { useApi } from "../../ui/use-api";

/** Сколько изменений видно в строке таблицы; остальное — в карточке записи. */
const CHANGES_IN_ROW = 3;

/**
 * Журнал действий (docs/29-admin-panel.md §3.4): только чтение — журнал из
 * панели не редактируется. Свежие первыми, дальше — «Показать ещё». Отбор —
 * по виду действий теми же группами, что в меню, по человеку (нажатием на
 * имя) и по объекту (из карточки записи).
 */
export function AuditScreen() {
  const [filter, setFilter] = useState<AuditFilter>(NO_AUDIT_FILTER);
  const { state, reload } = useApi(() => fetchAudit(api, filter, null), [filter.area, filter.actor?.id, filter.target?.id]);
  const [older, setOlder] = useState<{ entries: AuditEntry[]; next: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState<ApiError | "loading" | null>(null);
  const [open, setOpen] = useState<AuditEntry | null>(null);

  const apply = (next: AuditFilter) => {
    setOlder(null);
    setLoadingMore(null);
    setFilter(next);
  };
  const refresh = () => {
    setOlder(null);
    setLoadingMore(null);
    reload();
  };

  const entries = state.status === "ok" ? [...state.data.entries, ...(older?.entries ?? [])] : [];
  const next = older === null ? (state.status === "ok" ? state.data.next : null) : older.next;

  const more = async () => {
    if (next === null) return;
    setLoadingMore("loading");
    const result = await fetchAudit(api, filter, next);
    if (!result.ok) return setLoadingMore(result.error);
    setLoadingMore(null);
    setOlder((current) => ({ entries: [...(current?.entries ?? []), ...result.data.entries], next: result.data.next }));
  };

  const byActor = (entry: AuditEntry) => {
    if (entry.actorAccountId !== null) apply({ ...filter, actor: { id: entry.actorAccountId, name: entry.actorName ?? entry.actorAccountId.slice(0, 8) } });
  };
  const narrowed = filter.actor !== null || filter.target !== null;
  const filtered = narrowed || filter.area !== null;

  return (
    <Panel title="Журнал аудита" help={HELP.audit.journal} actions={<Button onClick={refresh}>Обновить</Button>}>
      <div className="mb-3 flex flex-col gap-2">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Вид действий">
          <Chip active={filter.area === null} onClick={() => apply({ ...filter, area: null })}>
            Все
          </Chip>
          {AUDIT_AREAS.map((area) => (
            <Chip key={area.id} active={filter.area === area.id} onClick={() => apply({ ...filter, area: area.id })}>
              {area.title}
            </Chip>
          ))}
        </div>
        {narrowed ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-text-muted">Только:</span>
            {filter.actor === null ? null : <Removable onRemove={() => apply({ ...filter, actor: null })}>действия: {filter.actor.name}</Removable>}
            {filter.target === null ? null : <Removable onRemove={() => apply({ ...filter, target: null })}>объект: {filter.target.name}</Removable>}
            <button type="button" onClick={() => apply(NO_AUDIT_FILTER)} className="px-1 text-text-muted underline-offset-2 hover:text-text hover:underline">
              сбросить всё
            </button>
          </div>
        ) : null}
      </div>

      {state.status === "loading" ? <Loading /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={refresh} /> : null}
      {state.status === "ok" ? (
        <div className="flex flex-col gap-3">
          <DataTable
            rows={entries}
            rowKey={(entry) => entry.entryId}
            onRowClick={setOpen}
            empty={filtered ? "По этому отбору записей нет" : "Журнал пуст"}
            columns={[
              { title: "Когда", render: (entry) => <span className="whitespace-nowrap">{formatDateTime(entry.createdAt)}</span> },
              { title: "Кто", render: (entry) => <ActorCell entry={entry} onPick={() => byActor(entry)} /> },
              { title: "Действие", render: (entry) => <ActionCell action={entry.action} /> },
              { title: "Над чем", render: (entry) => <ObjectCell entry={entry} /> },
              { title: "Что изменилось", help: HELP.audit.changes, render: (entry) => <ChangesCell entry={entry} /> },
            ]}
          />
          {next === null ? (
            entries.length > 0 ? <p className="text-xs text-text-muted">Это все записи{filtered ? " по отбору" : ""}.</p> : null
          ) : (
            <div className="flex items-center gap-3">
              <Button onClick={() => void more()} disabled={loadingMore === "loading"}>
                {loadingMore === "loading" ? "Загрузка…" : "Показать ещё"}
              </Button>
              {loadingMore !== null && loadingMore !== "loading" ? <ErrorNotice error={loadingMore} /> : null}
            </div>
          )}
        </div>
      ) : null}

      {open === null ? null : (
        <AuditEntryCard
          entry={open}
          onClose={() => setOpen(null)}
          onActor={() => {
            byActor(open);
            setOpen(null);
          }}
          onTarget={(name) => {
            if (open.target !== null) apply({ ...filter, area: null, target: { id: open.target, name } });
            setOpen(null);
          }}
        />
      )}
    </Panel>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-pill border px-3 py-1 text-xs transition-colors ${active ? "border-accent bg-accent/15 text-accent" : "border-border text-text-muted hover:border-border-strong hover:text-text"}`}
    >
      {children}
    </button>
  );
}

function Removable({ onRemove, children }: { onRemove: () => void; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-pill bg-accent/15 py-0.5 pr-1 pl-2.5 text-accent">
      {children}
      <button type="button" onClick={onRemove} aria-label="Убрать отбор" className="rounded-pill px-1 leading-none hover:bg-accent/25">
        ×
      </button>
    </span>
  );
}

/** Строка таблицы открывает запись — нажатие на имя и ссылку не должно её открывать. */
const stop = (event: MouseEvent) => event.stopPropagation();

function ActorCell({ entry, onPick }: { entry: AuditEntry; onPick: () => void }) {
  if (entry.actorAccountId === null) return <span className="text-text-muted">система</span>;
  return (
    <button
      type="button"
      title="Показать только действия этого человека"
      onClick={(event) => {
        stop(event);
        onPick();
      }}
      className="rounded-sm text-left underline decoration-border-strong decoration-dotted underline-offset-4 hover:text-accent hover:decoration-accent"
    >
      {entry.actorName ?? <code className="text-xs">{entry.actorAccountId.slice(0, 8)}</code>}
    </button>
  );
}

function ActionCell({ action }: { action: string }) {
  return isKnownAction(action) ? <span>{actionTitle(action)}</span> : <code className="text-xs">{action}</code>;
}

function ObjectCell({ entry }: { entry: AuditEntry }) {
  const object = auditObject(entry);
  if (object === null) return <span className="text-text-muted">—</span>;
  return (
    <span className="flex flex-col">
      <span className="text-xs text-text-muted">{object.kind}</span>
      {object.route === null ? (
        <span className="break-all">{object.label}</span>
      ) : (
        <a href={hrefOf(object.route)} onClick={stop} className="break-all text-accent hover:underline">
          {object.label}
        </a>
      )}
    </span>
  );
}

function ChangesCell({ entry }: { entry: AuditEntry }) {
  const changes = auditChanges(entry);
  if (changes.length === 0) return <span className="text-text-muted">—</span>;
  const mode = auditMode(entry);
  const hidden = changes.length - CHANGES_IN_ROW;
  return (
    <span className="flex max-w-md flex-col gap-0.5 text-xs">
      {changes.slice(0, CHANGES_IN_ROW).map((change) => (
        <span key={change.field} className="line-clamp-2">
          {change.field === "" ? null : <span className="text-text-muted">{fieldTitle(change.field)}: </span>}
          {mode === "update" ? (
            <>
              <span className="text-text-muted line-through decoration-text-disabled">{auditValue(change.before, change.field, 40)}</span>
              {" → "}
              <span>{auditValue(change.after, change.field, 40)}</span>
            </>
          ) : (
            <span className={mode === "remove" ? "text-text-muted" : ""}>{auditValue(mode === "remove" ? change.before : change.after, change.field, 60)}</span>
          )}
        </span>
      ))}
      {hidden > 0 ? <span className="text-text-disabled">и ещё {hidden} — в записи</span> : null}
    </span>
  );
}

/**
 * Запись целиком: кто, что, над чем, все изменённые поля полностью и, для
 * разбора, состояние как записано. Отсюда же — отбор по человеку и вся
 * история объекта.
 */
function AuditEntryCard({ entry, onClose, onActor, onTarget }: { entry: AuditEntry; onClose: () => void; onActor: () => void; onTarget: (name: string) => void }) {
  const object = auditObject(entry);
  const changes = auditChanges(entry);
  const mode = auditMode(entry);
  const actor = entry.actorAccountId === null ? "система" : (entry.actorName ?? entry.actorAccountId.slice(0, 8));
  const objectName = object === null ? (entry.target ?? "") : `${object.kind} ${object.label}`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={actionTitle(entry.action)}
      description={`${formatDateTime(entry.createdAt)} · ${actor}`}
      footer={
        <>
          {entry.actorAccountId === null ? null : (
            <Button className="mr-auto" onClick={onActor}>
              Все действия: {actor}
            </Button>
          )}
          {entry.target === null ? null : <Button onClick={() => onTarget(objectName)}>История объекта</Button>}
          {object === null || object.route === null ? null : (
            <Button tone="primary" onClick={() => (object.route === null ? undefined : navigate(object.route))}>
              Открыть
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <KeyValue
          items={[
            ["Кто", entry.actorAccountId === null ? "система — действие без человека" : <PersonLine name={entry.actorName} id={entry.actorAccountId} />],
            ["Действие", <ActionLine key="action" action={entry.action} />],
            ["Над чем", object === null ? "—" : <ObjectCell key="object" entry={entry} />],
          ]}
        />

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{mode === "create" ? "Что задали" : mode === "remove" ? "Что было" : "Что изменилось"}</h3>
          {changes.length === 0 ? (
            <p className="text-sm text-text-muted">Действие ничего не меняло — например, просмотр или вход.</p>
          ) : (
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-text-muted">
                  <th className="px-2 py-1.5 font-medium">Поле</th>
                  {mode === "create" ? null : <th className="px-2 py-1.5 font-medium">Было</th>}
                  {mode === "remove" ? null : <th className="px-2 py-1.5 font-medium">Стало</th>}
                </tr>
              </thead>
              <tbody>
                {changes.map((change) => (
                  <tr key={change.field} className="border-b border-border/60 align-top">
                    <td className="px-2 py-1.5 whitespace-nowrap text-text-muted">{change.field === "" ? "значение" : fieldTitle(change.field)}</td>
                    {mode === "create" ? null : <td className="px-2 py-1.5 break-words text-text-muted">{auditValue(change.before, change.field, 400)}</td>}
                    {mode === "remove" ? null : <td className="px-2 py-1.5 break-words">{auditValue(change.after, change.field, 400)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <details className="text-xs">
          <summary className="cursor-pointer text-text-muted hover:text-text">Как записано в журнале</summary>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Raw title="Было" value={entry.before} />
            <Raw title="Стало" value={entry.after} />
          </div>
          <p className="mt-2 text-text-disabled">
            Запись {entry.entryId}
            {entry.target === null ? "" : ` · объект ${entry.target}`}
          </p>
        </details>
      </div>
    </Dialog>
  );
}

function PersonLine({ name, id }: { name: string | null; id: string }) {
  return (
    <span className="flex flex-wrap items-baseline gap-2">
      {name ?? "аккаунт удалён"}
      <a href={hrefOf({ section: "players", id })} className="text-xs text-accent hover:underline">
        карточка
      </a>
    </span>
  );
}

function ActionLine({ action }: { action: string }) {
  return (
    <span className="flex flex-wrap items-baseline gap-2">
      {actionTitle(action)}
      {isKnownAction(action) ? <code className="text-xs text-text-disabled">{action}</code> : null}
    </span>
  );
}

function Raw({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-text-muted">{title}</span>
      <pre className="max-h-64 overflow-auto rounded-sm border border-border bg-surface-sunken p-2 whitespace-pre-wrap break-all">{prettyAudit(value)}</pre>
    </div>
  );
}
