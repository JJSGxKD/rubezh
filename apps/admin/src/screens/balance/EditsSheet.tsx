import type { DraftChange } from "../../api/content";
import { Button, Help } from "../../ui/kit";
import { HELP } from "../../ui/help";
import { describeChange, revertOf, type Names } from "./balance-rules";

/**
 * Лист «Правки» (tasks/T-0304): всё, что черновик меняет против версии-основы,
 * словами — «Волк · урон 7 → 9», — и «Вернуть» у каждой. Вернуть можно только
 * то, что в основе было: сервер умеет заменять значение, но не убирать поле.
 */
export function EditsSheet({
  changes,
  truncated,
  snapshot,
  names,
  canEdit,
  busyPath,
  onRevert,
  onGo,
}: {
  changes: readonly DraftChange[];
  /** отличий больше предела сервера: перечислены первые */
  truncated: boolean;
  snapshot: unknown;
  names: Names;
  canEdit: boolean;
  /** правка, которая сейчас уходит на сервер */
  busyPath: string | null;
  onRevert: (change: DraftChange) => void;
  onGo: (path: string) => void;
}) {
  return (
    <aside aria-label="Правки" className="flex w-full shrink-0 flex-col gap-2 rounded-md border border-border bg-surface p-3 lg:w-80">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        Правки
        <Help text={HELP.balance.edits} />
      </h3>
      {changes.length === 0 ? (
        <p className="text-sm text-text-muted">Правок нет — число меняется прямо в таблице.</p>
      ) : (
        <ul className="flex flex-col">
          {changes.map((change) => {
            const request = revertOf(change);
            return (
              <li key={change.path} className="flex items-start justify-between gap-2 border-b border-border/60 py-2 text-sm last:border-b-0">
                <button type="button" onClick={() => onGo(change.path)} className="min-w-0 text-left hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent">
                  {describeChange(change, snapshot, names)}
                </button>
                {canEdit ? (
                  <Button disabled={request === null || busyPath === change.path} title={request === null ? "В основе этого поля не было — убрать его правкой нельзя" : undefined} onClick={() => onRevert(change)}>
                    Вернуть
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {truncated ? <p className="text-xs text-text-muted">Отличий очень много — перечислены первые.</p> : null}
    </aside>
  );
}
