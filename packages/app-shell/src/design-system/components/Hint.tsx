import { useId, useState, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";

/**
 * Подсказка рядом с подписью (tasks/T-0136): кнопка «?» раскрывает пояснение
 * строкой под подписью, повторное нажатие сворачивает. Подсказка по наведению
 * на телефоне не работает, поэтому раскрытие — по нажатию.
 */
export function Hint(props: { label: string; text: string; children: ReactNode; initiallyOpen?: boolean }): ReactNode {
  const [open, setOpen] = useState(props.initiallyOpen ?? false);
  const textId = useId();

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5">
        {props.children}
        <button
          type="button"
          aria-label={`Что это: ${props.label}`}
          aria-expanded={open}
          aria-controls={textId}
          onClick={() => setOpen((current) => !current)}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-text-muted transition-opacity duration-(--duration-fast) ease-base active:opacity-70"
        >
          <CircleHelp size={14} aria-hidden="true" />
        </button>
      </div>
      {open ? (
        <p id={textId} className="mt-0.5 text-xs leading-snug text-text-muted">
          {props.text}
        </p>
      ) : null}
    </div>
  );
}
