import { useEffect, useState } from "react";
import { fetchPublication, publishDraft, type PublicationPreview } from "../../../api/content";
import { plural } from "../../../format";
import { api } from "../../../services";
import { ConfirmDialog } from "../../../ui/confirm-dialog";
import { HELP } from "../../../ui/help";
import { Badge, Button, ErrorNotice, Help, Loading, Notice } from "../../../ui/kit";
import { toast, toastError } from "../../../ui/toast";
import type { Loaded } from "../../../ui/use-api";
import { describeChange } from "../balance-rules";
import type { Rails } from "../check/check-rules";
import { dialogModel, publishUi, resultText } from "./publish-rules";

/** Сколько правок перечислить в окне «Всем»: остальные — числом, полный список — лист «Правки». */
const CHANGES_SHOWN = 40;

/**
 * Кнопки «Команде» и «Всем» (tasks/T-0306). «Команде» публикует сразу — это
 * обратимый шаг для своих, — а «Всем» сначала показывает окно со списком
 * правок против версии, которая сейчас в игре. Живут только при зелёных
 * рельсах проверки (`publish-rules.ts`); сервер проверяет то же ещё раз.
 */
export function PublishBar({
  draftId,
  rails,
  canPublish,
  requireCheck,
  narrow,
  snapshot,
  names,
  onChanged,
}: {
  draftId: string;
  rails: Rails;
  canPublish: boolean;
  /** ключ `content.publish-require-check`: выключен — кнопки не ждут рельсов, и это видно */
  requireCheck: boolean;
  narrow: boolean;
  /** снимок черновика: по нему правки в окне называются именами, а не путями */
  snapshot: unknown;
  names: Record<string, string>;
  /** публикация прошла: указатели и список версий читаются заново */
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [allOpen, setAllOpen] = useState(false);
  const ui = publishUi({ rails, canPublish, narrow, hasDraft: true, busy, requireCheck });
  if (!ui.visible) return null;

  const toTeam = async (): Promise<void> => {
    setBusy(true);
    const result = await publishDraft(api, draftId, "team");
    setBusy(false);
    if (!result.ok) {
      toastError(result.error, "Публикация не прошла");
      return;
    }
    toast.success(resultText("team", result.data));
    onChanged();
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button disabled={!ui.team.enabled} onClick={() => void toTeam()}>
        Команде
      </Button>
      <Button tone="primary" disabled={!ui.all.enabled} blockedBy={ui.all.hint} onClick={() => setAllOpen(true)}>
        Всем
      </Button>
      {requireCheck ? null : <Badge tone="warning">Проверка отключена ключом</Badge>}
      <Help text={HELP.balance.publish} />
      <PublishAllDialog open={allOpen} onOpenChange={setAllOpen} draftId={draftId} snapshot={snapshot} names={names} onPublished={onChanged} />
    </span>
  );
}

function PublishAllDialog({
  open,
  onOpenChange,
  draftId,
  snapshot,
  names,
  onPublished,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draftId: string;
  snapshot: unknown;
  names: Record<string, string>;
  onPublished: () => void;
}) {
  const [preview, setPreview] = useState<Loaded<PublicationPreview>>({ status: "loading" });

  // Окно открыто — правки считаются заново: пока человек думал, черновик или версия в игре могли измениться.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setPreview({ status: "loading" });
    void fetchPublication(api, draftId, "all").then((result) => {
      if (alive) setPreview(result.ok ? { status: "ok", data: result.data } : { status: "error", error: result.error });
    });
    return () => {
      alive = false;
    };
  }, [open, draftId]);

  const model = preview.status === "ok" ? dialogModel(preview.data) : null;
  const blocking = model === null ? "Считаем правки…" : model.canConfirm ? null : (model.warnings[0] ?? "Публиковать нечего");

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={model?.title ?? "Опубликовать всем?"}
      subject="Черновик станет версией игры у всех игроков. Откатить можно в «Истории»."
      problem={blocking}
      action="Опубликовать всем"
      onConfirm={async () => {
        const result = await publishDraft(api, draftId, "all");
        if (!result.ok) return { ok: false, error: result.error.message };
        toast.success(resultText("all", result.data));
        onPublished();
        return { ok: true };
      }}
    >
      {preview.status === "loading" ? <Loading /> : null}
      {preview.status === "error" ? <ErrorNotice error={preview.error} /> : null}
      {preview.status === "ok" && model !== null ? (
        <>
          <p className="text-sm">{model.summary}</p>
          {model.canConfirm ? model.warnings.map((warning) => <Notice key={warning} tone="warning">{warning}</Notice>) : null}
          <ChangeList preview={preview.data} snapshot={snapshot} names={names} />
        </>
      ) : null}
    </ConfirmDialog>
  );
}

function ChangeList({ preview, snapshot, names }: { preview: PublicationPreview; snapshot: unknown; names: Record<string, string> }) {
  if (preview.changes.length === 0) return null;
  const shown = preview.changes.slice(0, CHANGES_SHOWN);
  const rest = preview.changes.length - shown.length;
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-sm bg-surface-sunken px-3 py-2 text-sm">
        {shown.map((change) => (
          <li key={change.path} className="break-words">
            {describeChange(change, snapshot, names)}
          </li>
        ))}
      </ul>
      {rest > 0 || preview.truncated ? (
        <p className="text-xs text-text-muted">
          И ещё {String(rest)}
          {preview.truncated ? "+" : ""} {plural(rest, ["правка", "правки", "правок"])}: список обрезан.
        </p>
      ) : null}
    </div>
  );
}
