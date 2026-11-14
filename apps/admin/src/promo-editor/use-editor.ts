import { useCallback, useEffect, useRef, useState } from "react";
import type { PartnerEdits, PromoDoc } from "@bh/promo-kit";
import type { Mode } from "./fabric-doc";
import { canRedo, canUndo, createHistory, pushHistory, redo, undo, type History } from "./history";
import { applyPartnerChange, type PartnerChange } from "./partner-edit";

/**
 * Состояние редактора промо (tasks/T-0274): документ, стопка отмены, правки
 * партнёра и его фото. Всё, что можно отменить, лежит в одном снимке, чтобы
 * отмена возвращала документ и фото вместе: иначе после отмены замены
 * картинка осталась бы прежней, а документ уже нет.
 */
export interface EditorSnapshot {
  doc: PromoDoc;
  /** правки партнёра поверх шаблона; в режиме команды всегда `null` */
  edits: PartnerEdits | null;
  /** адреса своих фото партнёра по id слоя: живут в браузере, на сервер не уходят */
  locals: Readonly<Record<string, string>>;
}

export interface EditorState {
  snapshot: EditorSnapshot;
  /** почему последнее действие не прошло; `null` — всё хорошо */
  notice: string | null;
  setNotice(message: string | null): void;
  canUndo: boolean;
  canRedo: boolean;
  undo(): void;
  redo(): void;
  /** режим команды: новый документ из старого; `key` склеивает подряд идущие правки одного поля */
  editDoc(change: (doc: PromoDoc) => PromoDoc, key?: string): void;
  /** режим партнёра: одна правка через `applyPartnerEdits`; `local` — адрес его фото для слоя */
  partnerChange(change: PartnerChange, local?: string): void;
}

export function useEditorState(initial: PromoDoc, mode: Mode, onChange?: (doc: PromoDoc, edits: PartnerEdits | null) => void): EditorState {
  const [history, setHistory] = useState<History<EditorSnapshot>>(() => createHistory({ doc: initial, edits: null, locals: {} }));
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useRef(history);
  latest.current = history;
  const template = useRef(initial);

  // Наружу уходит каждое новое состояние, кроме самого первого: оно пришло снаружи.
  const emitted = useRef(history.present);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (emitted.current === history.present) return;
    emitted.current = history.present;
    onChangeRef.current?.(history.present.doc, history.present.edits);
  }, [history.present]);

  const editDoc = useCallback((change: (doc: PromoDoc) => PromoDoc, key?: string) => {
    setNotice(null);
    setHistory((current) => {
      const doc = change(current.present.doc);
      return doc === current.present.doc ? current : pushHistory(current, { ...current.present, doc }, key ?? null);
    });
  }, []);

  const partnerChange = useCallback(
    (change: PartnerChange, local?: string) => {
      if (mode !== "partner") return;
      const current = latest.current.present;
      const result = applyPartnerChange(template.current, current.edits, change);
      if (!result.ok) {
        setNotice(result.message);
        return;
      }
      setNotice(null);
      const locals = local === undefined ? current.locals : { ...current.locals, [change.layerId]: local };
      setHistory((now) => pushHistory(now, { doc: result.doc, edits: result.edits, locals }, local === undefined ? `${change.layerId}:${change.field}` : null));
    },
    [mode],
  );

  return {
    snapshot: history.present,
    notice,
    setNotice,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    undo: useCallback(() => setHistory((current) => undo(current)), []),
    redo: useCallback(() => setHistory((current) => redo(current)), []),
    editDoc,
    partnerChange,
  };
}
