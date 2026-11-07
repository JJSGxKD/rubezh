import { useState } from "react";
import type { ApiResult } from "../../api/client";
import { POSTBACK_EXAMPLE, POSTBACK_HINT, POSTBACK_PARAMS_NOTE, postbackSaveError, postbackState, type LinkEventsView } from "../../api/links";
import { Button, Field, TextArea } from "../../ui/kit";
import { toast } from "../../ui/toast";
import { PostbackEvents } from "./PostbackEvents";

/**
 * Блок «Адрес постбэка» (tasks/T-0070): общий для карточки ссылки и карточки партнёра. Человек вставляет адрес с
 * макросами, «Вставить пример» подставляет образец, «Сохранить» отправляет адрес на сервер, «Убрать адрес» снимает
 * его. Ошибка проверки — под полем словами сервера, введённое остаётся. Под адресом — флажки событий (T-0071,
 * `PostbackEvents`). Блок рисуют только тем, у кого есть право на правку; пока данные не загрузились, карточка вместо
 * него показывает загрузку.
 *
 * После сохранения родитель перечитывает данные и меняет `key` блока — поле тогда начинается с сохранённого адреса.
 */
export function PostbackBlock({
  title,
  label,
  address,
  since,
  events,
  save,
  saveEvents,
  onSaved,
}: {
  title: string;
  label: string;
  /** сохранённый адрес целиком; `null` — не задан */
  address: string | null;
  since: string | null;
  /** какие события показывать и можно ли их менять; адреса нет нигде — флажков нет */
  events: LinkEventsView;
  save: (url: string | null) => Promise<ApiResult<unknown>>;
  saveEvents: (events: string[]) => Promise<ApiResult<unknown>>;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(address ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = value.trim() !== (address ?? "");

  const submit = async (url: string | null) => {
    setSaving(true);
    setError(null);
    const result = await save(url);
    setSaving(false);
    // Ошибка не закрывает поле: введённое остаётся, чтобы его поправить, а не набирать заново.
    if (!result.ok) return setError(postbackSaveError(result.error));
    toast.success(url === null || url.trim() === "" ? "Адрес постбэка снят" : "Адрес постбэка сохранён");
    onSaved();
  };

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      <Field label={label} help={POSTBACK_HINT} error={error ?? undefined} hint={POSTBACK_PARAMS_NOTE}>
        <TextArea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={saving}
          rows={3}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="https://…"
          className="w-full font-mono text-xs break-all"
        />
      </Field>
      <p className="text-xs text-text-muted">{postbackState({ postbackUrl: address, postbackSince: since })}</p>
      <PostbackEvents view={events} save={saveEvents} onSaved={onSaved} />
      <div className="flex flex-wrap gap-2">
        <Button tone="primary" disabled={saving || !changed} onClick={() => void submit(value)}>
          {saving ? "Сохраняю…" : "Сохранить"}
        </Button>
        <Button disabled={saving || address === null} onClick={() => void submit(null)}>
          Убрать адрес
        </Button>
        <Button disabled={saving} onClick={() => setValue(POSTBACK_EXAMPLE)}>
          Вставить пример
        </Button>
      </div>
    </section>
  );
}
