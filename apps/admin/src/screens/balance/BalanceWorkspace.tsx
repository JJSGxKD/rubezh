import { useMemo, useState } from "react";
import { createDraft, patchDraft, type ContentVersion, type DraftChange, type DraftDetail, type DraftDiff, type DraftSummary, type VersionSummary } from "../../api/content";
import { formatDateTime, plural } from "../../format";
import { api } from "../../services";
import { Dialog } from "../../ui/dialog";
import { HELP } from "../../ui/help";
import { Button, Field, Help, Input, Notice, Select } from "../../ui/kit";
import { navigate } from "../../ui/router";
import { TabBar } from "../../ui/tab-bar";
import { toastError } from "../../ui/toast";
import { useNarrow } from "../../ui/use-media";
import type { CellContext } from "./balance-cells";
import { afterPatch, describePath, indexChanges, mergeChange, revertOf, type EditorState } from "./balance-rules";
import { parseSnapshot } from "./balance-snapshot";
import { TABS, isTabId, tabOfPath, tablesFor, type TabId } from "./balance-tables";
import { BalanceTable } from "./BalanceTable";
import { EditsSheet } from "./EditsSheet";

const DRAFT_TITLE_MAX = 80;

function defaultTitle(): string {
  return `Черновик ${new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" }).format(new Date())}`;
}

/** Автор — идентификатор аккаунта: имени в ответе сервера нет, поэтому «вы» или начало номера. */
function authorText(author: string, meId: string): string {
  return author === meId ? "вы" : `№${author.slice(0, 8)}`;
}

/**
 * Рабочая область «Баланса» (tasks/T-0304): шапка с версиями и черновиком,
 * вкладки-разделы, таблицы с правкой в ячейке и лист «Правки». Всё, что
 * зависит от черновика, держит этот компонент: ответ сервера на правку
 * меняет и снимок, и список правок без повторного запроса.
 */
export function BalanceWorkspace({
  latest,
  drafts,
  reloadDrafts,
  version,
  draft,
  diff,
  canEdit,
  meId,
  initialTab,
}: {
  latest: VersionSummary;
  drafts: readonly DraftSummary[];
  reloadDrafts: () => void;
  /** версия-основа: из неё имена, а без черновика — и сами числа */
  version: ContentVersion;
  draft: DraftDetail | null;
  diff: DraftDiff | null;
  canEdit: boolean;
  meId: string;
  initialTab: string | undefined;
}) {
  const narrow = useNarrow();
  const names = version.names;
  const [tab, setTab] = useState<TabId>(isTabId(initialTab) ? initialTab : "enemies");
  const [editor, setEditor] = useState<EditorState>(() => ({ snapshot: draft === null ? version.snapshot : draft.snapshot, errors: {} }));
  const [changes, setChanges] = useState<DraftChange[]>(() => diff?.changes ?? []);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);

  const parsed = useMemo(() => parseSnapshot(editor.snapshot), [editor.snapshot]);
  const changeIndex = useMemo(() => indexChanges(changes), [changes]);
  const readOnly = !canEdit || draft === null || narrow;

  const patch = async (path: string, value: unknown, typed: string, wasText: string): Promise<void> => {
    if (draft === null) return;
    setBusyPath(path);
    const result = await patchDraft(api, draft.draftId, path, value);
    setBusyPath((current) => (current === path ? null : current));
    setEditor((previous) => afterPatch(previous, { path, typed, wasText }, result, names));
    if (result.ok) setChanges((previous) => mergeChange(previous, result.data));
    // Отказ формы — строка под записью; всё остальное (связь, права, лимит) строкой не объяснить.
    else if (result.error.kind !== "rejected") toastError(result.error);
  };

  const revert = async (change: DraftChange): Promise<void> => {
    const request = revertOf(change);
    if (draft === null || request === null) return;
    setBusyPath(change.path);
    const result = await patchDraft(api, draft.draftId, request.path, request.value);
    setBusyPath(null);
    if (result.ok) {
      setEditor((previous) => afterPatch(previous, { path: change.path, typed: "", wasText: "" }, result, names));
      setChanges((previous) => mergeChange(previous, result.data));
    } else toastError(result.error);
  };

  const ctx: CellContext = {
    changes: changeIndex,
    errors: editor.errors,
    readOnly,
    label: (path) => describePath(path, editor.snapshot, names),
    onNumber: (path, value, typed, wasText) => void patch(path, value, typed, wasText),
    onSelect: (path, value, wasText) => void patch(path, value, String(value), wasText),
    onDismiss: (path) =>
      setEditor((previous) => ({ snapshot: previous.snapshot, errors: Object.fromEntries(Object.entries(previous.errors).filter(([key]) => key !== path)) })),
  };

  const create = async (): Promise<void> => {
    setSaving(true);
    const result = await createDraft(api, title);
    setSaving(false);
    if (!result.ok) {
      toastError(result.error);
      return;
    }
    setCreating(false);
    reloadDrafts();
    navigate({ section: "balance", id: result.data.draftId });
  };

  // Вкладка — в адресе: ссылку на раздел черновика можно отправить коллеге. Без черновика в адресе только раздел меню.
  const selectTab = (next: TabId): void => {
    setTab(next);
    if (draft !== null) navigate({ section: "balance", id: draft.draftId, tab: next });
  };

  const counts: Partial<Record<TabId, number>> = {};
  for (const change of changes) {
    const owner = tabOfPath(change.path);
    if (owner !== null) counts[owner] = (counts[owner] ?? 0) + 1;
  }

  const listed = draft !== null && !drafts.some((item) => item.draftId === draft.draftId) ? [draft, ...drafts] : drafts;
  const changeCount = `${String(changes.length)}${diff?.truncated === true ? "+" : ""}`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-2 rounded-sm bg-surface px-2.5 py-1 text-sm">
          <i aria-hidden="true" className="inline-block size-2 rounded-full bg-success" />
          В игре: v{latest.versionNo} · {formatDateTime(latest.createdAt)}
        </span>
        {draft === null ? null : (
          <span className="inline-flex items-center gap-2 rounded-sm bg-surface px-2.5 py-1 text-sm">
            <i aria-hidden="true" className="inline-block size-2 rounded-full bg-warning" />
            Черновик: {changeCount} {plural(changes.length, ["правка", "правки", "правок"])} · {authorText(draft.author, meId)}
            <Help text={HELP.balance.draft} />
          </span>
        )}
        <Help text={HELP.balance.section} />
        <span className="flex-1" />
        <Select
          aria-label="Черновик"
          value={draft?.draftId ?? ""}
          onChange={(event) => navigate({ section: "balance", id: event.target.value === "" ? null : event.target.value })}
          className="max-w-64"
        >
          <option value="">Версия в игре, только чтение</option>
          {listed.map((item) => (
            <option key={item.draftId} value={item.draftId}>
              {item.title}
            </option>
          ))}
        </Select>
        {canEdit ? (
          <Button
            tone={draft === null ? "primary" : "secondary"}
            onClick={() => {
              setTitle(defaultTitle());
              setCreating(true);
            }}
          >
            Новый черновик
          </Button>
        ) : null}
        {draft === null ? null : (
          <Button onClick={() => setSheetOpen((open) => !open)} aria-pressed={sheetOpen}>
            Правки · {changeCount}
          </Button>
        )}
        <Button disabled title="Проверка симуляцией и коридорами — следующим шагом">
          Проверить
        </Button>
      </div>

      {narrow ? <Notice tone="info">На телефоне баланс только читается: править таблицу чисел на узком экране — способ ошибиться.</Notice> : null}
      {draft === null && !narrow ? (
        <Notice tone="info">{canEdit ? `Показана версия v${String(version.versionNo)} — так числа лежат в игре. Чтобы править, создайте черновик.` : "Только чтение: для правки нужно право «content.edit»."}</Notice>
      ) : null}
      {draft !== null && !canEdit ? <Notice tone="info">Только чтение: для правки нужно право «content.edit».</Notice> : null}

      <TabBar label="Разделы баланса" tabs={TABS} active={tab} counts={counts} onSelect={selectTab} />

      <div className="flex min-w-0 flex-col gap-4">
        {parsed.ok ? tablesFor(tab, parsed.snapshot, names).map((model) => <BalanceTable key={model.key} model={model} ctx={ctx} />) : <Notice>{parsed.message}</Notice>}
        {draft !== null && sheetOpen ? (
          <EditsSheet
            changes={changes}
            truncated={diff?.truncated === true}
            snapshot={editor.snapshot}
            names={names}
            canEdit={canEdit && !narrow}
            busyPath={busyPath}
            onRevert={(change) => void revert(change)}
            onClose={() => setSheetOpen(false)}
            onGo={(path) => {
              const owner = tabOfPath(path);
              if (owner !== null) selectTab(owner);
            }}
          />
        ) : null}
      </div>

      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="Новый черновик"
        description={`Копия версии v${String(latest.versionNo)}: в ней вы правите числа. Игроки черновик не видят.`}
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Отмена</Button>
            <Button tone="primary" disabled={saving || title.trim() === ""} onClick={() => void create()}>
              Создать
            </Button>
          </>
        }
      >
        <Field label="Название" hint={`До ${String(DRAFT_TITLE_MAX)} знаков — по нему черновик найдут в списке.`}>
          <Input value={title} maxLength={DRAFT_TITLE_MAX} onChange={(event) => setTitle(event.target.value)} autoFocus />
        </Field>
      </Dialog>
    </div>
  );
}
