import { useState } from "react";
import type { ApiResult } from "../../api/client";
import {
  INHERITED_EVENTS_CAPTION,
  INHERITED_EVENTS_NOTE,
  POSTBACK_EVENTS_LATER_NOTE,
  POSTBACK_EVENT_OPTIONS,
  canonicalEvents,
  eventsChoice,
  postbackSaveError,
  type LinkEventsView,
} from "../../api/links";
import { Button } from "../../ui/kit";
import { toast } from "../../ui/toast";

/**
 * Флажки событий в блоке «Постбэк» (tasks/T-0071): какие события уходят на адрес — регистрация, первая и повторная
 * покупка, возврат на следующий день. Свой адрес — флажки меняются и сохраняются кнопкой; общий адрес партнёра у ссылки
 * без своего — те же флажки, но недоступные: их меняют в карточке партнёра; адреса нет нигде — флажков нет, о том, что
 * ничего не отправляется, говорит строка блока.
 *
 * Ничего не отмечено — «Выберите хотя бы одно событие» под флажками, запрос не уходит. Ошибка сервера — под флажками,
 * отмеченное остаётся. После сохранения родитель перечитывает данные и меняет `key` блока — флажки начинаются с
 * сохранённого выбора.
 */
export function PostbackEvents({ view, save, onSaved }: { view: LinkEventsView; save: (events: string[]) => Promise<ApiResult<unknown>>; onSaved: () => void }) {
  const [selected, setSelected] = useState<string[]>(view.kind === "none" ? [] : view.events);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (view.kind === "none") return null;

  const locked = view.kind === "inherited";
  const choice = eventsChoice(selected);
  const changed = canonicalEvents(selected).join() !== canonicalEvents(view.events).join();
  // Пустой выбор виден сразу: сохранить его нельзя, и человек должен понимать почему, а не гадать над серой кнопкой.
  const shown = error ?? (choice.ok ? undefined : choice.error);

  const toggle = (event: string, checked: boolean) => {
    setError(null);
    setSelected(checked ? [...selected, event] : selected.filter((item) => item !== event));
  };

  const submit = async () => {
    if (!choice.ok) return setError(choice.error);
    setSaving(true);
    setError(null);
    const result = await save(choice.events);
    setSaving(false);
    if (!result.ok) return setError(postbackSaveError(result.error));
    toast.success("События постбэка сохранены");
    onSaved();
  };

  return (
    <fieldset className="flex flex-col gap-2" disabled={saving || locked}>
      <legend className="mb-1 text-xs text-text-muted">{locked ? INHERITED_EVENTS_CAPTION : "События"}</legend>
      {POSTBACK_EVENT_OPTIONS.map((option) => (
        <label key={option.event} className={`flex items-start gap-2 text-sm ${locked ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
          <input type="checkbox" className="mt-1 shrink-0" checked={selected.includes(option.event)} onChange={(event) => toggle(option.event, event.target.checked)} />
          <span className="flex flex-col">
            <span>{option.title}</span>
            <span className="text-xs leading-snug text-text-muted">{option.hint}</span>
          </span>
        </label>
      ))}
      {shown === undefined ? null : (
        <p role="alert" className="text-xs text-danger">
          {shown}
        </p>
      )}
      {locked ? (
        <p className="text-xs text-text-muted">{INHERITED_EVENTS_NOTE}</p>
      ) : (
        <>
          <p className="text-xs text-text-muted">{POSTBACK_EVENTS_LATER_NOTE}</p>
          <div>
            <Button tone="primary" disabled={saving || !changed || !choice.ok} onClick={() => void submit()}>
              {saving ? "Сохраняю…" : "Сохранить события"}
            </Button>
          </div>
        </>
      )}
    </fieldset>
  );
}
