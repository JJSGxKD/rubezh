import { useState } from "react";
import type { ApiError, ApiResult } from "../../api/client";
import { PURCHASE_NOTE_MAX, purchaseNoteProblem } from "../../api/players";
import { hrefOf } from "../../routes";
import { Dialog } from "../../ui/dialog";
import { Button, Field, Notice, TextArea } from "../../ui/kit";
import { toast } from "../../ui/toast";

/** Общие части вкладок «Расхождения» и «Брошенные задания» (tasks/T-0438). */

/** Сколько знаков идентификатора оплаты видно в таблице: полный — в подсказке и при копировании. */
const CHARGE_SHORT = 12;

/** Скопировать в буфер: успех и отказ браузера — уведомлением, а не молчанием. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast("Скопировано");
  } catch {
    toast.error("Не удалось скопировать");
  }
}

/** Идентификатор оплаты: первые знаки с «…», полностью — подсказкой и кнопкой «копировать». */
export function ChargeId({ value }: { value: string | null }) {
  if (value === null) return <>—</>;
  const short = value.length > CHARGE_SHORT ? `${value.slice(0, CHARGE_SHORT)}…` : value;
  return (
    <span className="inline-flex items-baseline gap-x-2">
      <span className="font-mono text-xs" title={value}>
        {short}
      </span>
      <button type="button" className="shrink-0 text-xs text-text-muted underline hover:text-text" onClick={() => void copyText(value)}>
        копировать
      </button>
    </span>
  );
}

/** Ссылка «открыть →» на карточку платежа или прочерк. */
export function PurchaseOpen({ purchaseId }: { purchaseId: string | null }) {
  if (purchaseId === null) return <>—</>;
  return (
    <a href={hrefOf({ section: "payments", id: purchaseId })} className="whitespace-nowrap text-accent underline-offset-2 hover:underline">
      открыть →
    </a>
  );
}

/** Текст в одну строку с «…»: полный — подсказкой. */
export function OneLine({ text, widthClass = "max-w-[16rem]" }: { text: string; widthClass?: string }) {
  return (
    <span className={`block truncate ${widthClass}`} title={text}>
      {text}
    </span>
  );
}

export interface NoteActionProps {
  title: string;
  /** кто и что: строка под заголовком окна */
  description: string;
  body: string;
  /** подпись главной кнопки — с суммой, если действие трогает деньги */
  confirm: string;
  tone: "primary" | "danger";
  run: (note: string) => Promise<ApiResult<unknown>>;
  /** уведомление об успехе */
  done: { title: string; description?: string };
  onClose: () => void;
  /** действие прошло или стало недоступным (`409`): список перечитывается */
  onDone: () => void;
}

/**
 * Действие с причиной (3–200 знаков) для вкладок расхождений и заданий. Пока
 * запрос летит, окно не закрывается и кнопка выключена: двойное нажатие
 * второй раз получило бы `409`. Окно создаётся под каждое действие заново —
 * причина прежнего не остаётся в поле.
 */
export function NoteActionDialog({ title, description, body, confirm, tone, run, done, onClose, onDone }: NoteActionProps) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const close = () => {
    if (!pending) onClose();
  };

  const submit = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await run(note.trim());
    setPending(false);
    if (!result.ok) {
      if (result.error.status === 409) onDone();
      return setError(result.error);
    }
    toast.success(done.title, done.description === undefined ? {} : { description: done.description });
    onClose();
    onDone();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : close())}
      title={title}
      description={description}
      footer={
        <>
          <Button disabled={pending} onClick={close}>
            Отмена
          </Button>
          <Button tone={tone} disabled={purchaseNoteProblem(note) !== null || pending} onClick={() => void submit()}>
            {pending ? "Отправляем…" : confirm}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm">{body}</p>
        <Field label="Причина" hint="Попадёт в журнал действий и в сообщение команде в поток «Покупки».">
          <TextArea rows={3} maxLength={PURCHASE_NOTE_MAX} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
        <p className="text-right text-xs text-text-muted">
          {note.trim().length} / {PURCHASE_NOTE_MAX}
        </p>
        {error === null ? null : <Notice>{error.message}</Notice>}
      </div>
    </Dialog>
  );
}
