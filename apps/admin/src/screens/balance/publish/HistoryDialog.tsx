import { useMemo, useState } from "react";
import { mergeFromCode, rollbackTo, type Audience, type CurrentPointers, type VersionSummary } from "../../../api/content";
import { formatDateTime } from "../../../format";
import { api } from "../../../services";
import { ConfirmDialog } from "../../../ui/confirm-dialog";
import { Dialog } from "../../../ui/dialog";
import { HELP } from "../../../ui/help";
import { Badge, Button, Help, Notice } from "../../../ui/kit";
import { toast, toastError } from "../../../ui/toast";
import { AUDIENCE_LABEL, historyRows, rollbackText, type HistoryRow } from "./publish-rules";

/** Строк «Истории» до «Показать ещё»: каждый выкат кода заводит версию, список растёт без конца. */
const PAGE = 30;

interface RollbackTarget {
  audience: Audience;
  versionNo: number;
}

/**
 * «История и откат» (tasks/T-0306): версии с автором, датой и тем, у какой
 * аудитории они сейчас в игре. «Откатить» — указатель на версию, что уже
 * бывала в игре: новой версии не заводит, клиент возьмёт её при следующем
 * входе. «Взять из кода» дописывает в черновик то новое, что пришло с кодом,
 * пока в игре стоит версия из панели. На телефоне доступны просмотр и откат.
 */
export function HistoryDialog({
  open,
  onOpenChange,
  versions,
  current,
  canPublish,
  canEdit,
  draftId,
  meId,
  onChanged,
  onMerged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  versions: readonly VersionSummary[];
  current: CurrentPointers;
  canPublish: boolean;
  canEdit: boolean;
  /** открытый черновик; без него «Взять из кода» нет */
  draftId: string | null;
  meId: string;
  /** откат прошёл: указатели читаются заново */
  onChanged: () => void;
  /** черновик пополнен кодом: его снимок и основа читаются заново */
  onMerged: () => void;
}) {
  const [shown, setShown] = useState(PAGE);
  const [target, setTarget] = useState<RollbackTarget | null>(null);
  const [merging, setMerging] = useState<number | null>(null);
  const rows = useMemo(() => historyRows({ versions, current, canPublish, canEdit, hasDraft: draftId !== null, meId }), [versions, current, canPublish, canEdit, draftId, meId]);

  const merge = async (versionNo: number): Promise<void> => {
    if (draftId === null) return;
    setMerging(versionNo);
    const result = await mergeFromCode(api, draftId, versionNo);
    setMerging(null);
    if (!result.ok) {
      toastError(result.error, "Не удалось взять из кода");
      return;
    }
    toast.success(result.data.changed ? `Из кода добавлено: ${String(result.data.added)}. Основа черновика — v${String(result.data.baseVersionNo)}` : "В версии из кода нет нового для этого черновика");
    if (result.data.changed) {
      onOpenChange(false);
      onMerged();
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title="История и откат"
        description="Версии баланса: у какой аудитории какая в игре сейчас. Откат возвращает указатель, новой версии не заводит."
        footer={<Button onClick={() => onOpenChange(false)}>Закрыть</Button>}
      >
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-1.5 text-xs text-text-muted">
            «Команде» — аккаунты с ролью, «Всем» — все игроки. <Help text={HELP.balance.history} />
          </p>
          {rows.length === 0 ? <p className="text-sm text-text-muted">Версий ещё нет — версию 0 заводит выкат командой content:import.</p> : null}
          {current.all === null && rows.length > 0 ? <Notice tone="info">Пока ничего не публиковалось: игроки играют встроенным контентом.</Notice> : null}
          <ul className="flex flex-col gap-2">
            {rows.slice(0, shown).map((row) => (
              <Row key={row.versionNo} row={row} merging={merging === row.versionNo} onRollback={(audience) => setTarget({ audience, versionNo: row.versionNo })} onMerge={() => void merge(row.versionNo)} />
            ))}
          </ul>
          {rows.length > shown ? (
            <div>
              <Button onClick={() => setShown((value) => value + PAGE)}>Показать ещё</Button>
            </div>
          ) : null}
        </div>
      </Dialog>

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(next) => {
          if (!next) setTarget(null);
        }}
        title={target === null ? "Откатить?" : `Откатить «${AUDIENCE_LABEL[target.audience]}» на v${String(target.versionNo)}?`}
        subject="Новой версии откат не заводит: указатель вернётся на версию, что уже бывала в игре. Игроки получат её при следующем входе."
        action="Откатить"
        onConfirm={async () => {
          if (target === null) return { ok: false, error: "Не выбрана версия" };
          const result = await rollbackTo(api, target.audience, target.versionNo);
          if (!result.ok) return { ok: false, error: result.error.message };
          toast.success(rollbackText(target.audience, result.data));
          onChanged();
          return { ok: true };
        }}
      />
    </>
  );
}

function Row({ row, merging, onRollback, onMerge }: { row: HistoryRow; merging: boolean; onRollback: (audience: Audience) => void; onMerge: () => void }) {
  return (
    <li className="flex flex-col gap-1.5 rounded-sm border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold tabular-nums">v{row.versionNo}</span>
        {row.live.map((audience) => (
          <Badge key={audience} tone="success">
            В игре: {audience === "all" ? "у всех" : "у команды"}
          </Badge>
        ))}
        <span className="text-xs text-text-muted">
          {row.author} · {formatDateTime(row.date)}
        </span>
      </div>
      {row.note === null ? null : <p className="text-xs text-warning">{row.note}</p>}
      {row.rollbackTo.length === 0 && !row.takeFromCode ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {row.rollbackTo.map((audience) => (
            <Button key={audience} onClick={() => onRollback(audience)}>
              Откатить «{AUDIENCE_LABEL[audience]}»
            </Button>
          ))}
          {row.takeFromCode ? (
            <Button disabled={merging} onClick={onMerge}>
              {merging ? "Берём…" : "Взять из кода"}
            </Button>
          ) : null}
        </div>
      )}
    </li>
  );
}
