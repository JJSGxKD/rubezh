import { useState, type ReactNode } from "react";
import { Dialog } from "./dialog";
import { Button, Field, Notice, TextArea } from "./kit";

/**
 * Окно действия — для денег, необратимого и видимого игрокам
 * (docs/29-admin-panel.md §4, «Подтверждения»). Обратимое внутри команды
 * делается сразу, с «Отменить» (`toastWithUndo`).
 */

export interface ConfirmChange {
  label: string;
  value: ReactNode;
}

interface ReasonRule {
  min: number;
  max: number;
}

/**
 * Можно ли нажать главную кнопку. Вынесено из компонента ради теста: причина
 * считается по обрезанному тексту, как её и отправит окно.
 */
export function confirmReady(reason: string, rule: ReasonRule | undefined, pending: boolean, problem: string | null = null): boolean {
  if (pending || problem !== null) return false;
  if (rule === undefined) return true;
  const length = reason.trim().length;
  return length >= rule.min && length <= rule.max;
}

export function ConfirmDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** чего касается: «Стартовый набор · 50 ⭐ · Алина» */
  subject?: string;
  changes?: readonly ConfirmChange[];
  /** поля самого действия над «что изменится»: ресурс и сумма у кошелька */
  children?: ReactNode;
  /** пока не `null` — поля не годны: кнопка недоступна, текст — под полями */
  problem?: string | null;
  /** нужна причина: пределы, подпись, подсказка под полем */
  reason?: { min: number; max: number; label?: string; hint?: string };
  /** текст главной кнопки — само действие */
  action: string;
  tone?: "primary" | "danger";
  /** выполнить; бросать не должно: ошибку — строкой в `error` */
  onConfirm: (reason: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}): ReactNode {
  const { reason: rule, problem = null } = props;
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = (): void => {
    setReason("");
    setError(null);
    props.onOpenChange(false);
  };

  const submit = async (): Promise<void> => {
    setPending(true);
    setError(null);
    const result = await props.onConfirm(reason.trim());
    setPending(false);
    if (result.ok) return close();
    setError(result.error);
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => (open ? props.onOpenChange(true) : close())}
      title={props.title}
      {...(props.subject === undefined ? {} : { description: props.subject })}
      footer={
        <>
          <Button onClick={close}>Отмена</Button>
          <Button tone={props.tone ?? "primary"} disabled={!confirmReady(reason, rule, pending, problem)} onClick={() => void submit()}>
            {pending ? "Выполняем…" : props.action}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {props.children}
        {problem === null ? null : <p className="text-xs text-text-muted">{problem}</p>}
        {props.changes === undefined || props.changes.length === 0 ? null : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-sm bg-surface-sunken px-3 py-2 text-sm">
            {props.changes.map((change) => (
              <div key={change.label} className="contents">
                <dt className="text-text-muted">{change.label}</dt>
                <dd className="text-right tabular-nums">{change.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {rule === undefined ? null : (
          <Field label={rule.label ?? "Причина"} {...(rule.hint === undefined ? {} : { hint: rule.hint })}>
            <TextArea rows={3} maxLength={rule.max} value={reason} onChange={(event) => setReason(event.target.value)} />
            <span className="text-right text-xs text-text-muted tabular-nums">
              {reason.length} / {rule.max}
            </span>
          </Field>
        )}
        {error === null ? null : <Notice>{error}</Notice>}
      </div>
    </Dialog>
  );
}
