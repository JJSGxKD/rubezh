import { useId, useState, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";

/**
 * Подсказка рядом с подписью (tasks/T-0136): кнопка «?» раскрывает пояснение
 * под всей строкой, повторное нажатие сворачивает. `end` — то, что стоит справа
 * в строке (значение параметра). Пояснение идёт во всю ширину, а не в колонку
 * подписи: на 320 px в узкой колонке оно ломало строку. Подсказка по наведению
 * на телефоне не работает, поэтому раскрытие — по нажатию.
 */
export function Hint(props: {
  label: string;
  text: string;
  children: ReactNode;
  end?: ReactNode;
  initiallyOpen?: boolean;
}): ReactNode {
  const [open, setOpen] = useState(props.initiallyOpen ?? false);
  const textId = useId();

  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          {props.children}
          {/* Значок 20 px, а область нажатия — 40 px: в списке строки стоят плотно. */}
          <button
            type="button"
            aria-label={`Что это: ${props.label}`}
            aria-expanded={open}
            aria-controls={textId}
            onClick={() => setOpen((current) => !current)}
            className="relative inline-flex size-5 shrink-0 items-center justify-center rounded-full text-text-muted transition-opacity duration-(--duration-fast) ease-base before:absolute before:-inset-2.5 active:opacity-70"
          >
            <CircleHelp size={14} aria-hidden="true" />
          </button>
        </div>
        {props.end}
      </div>
      {open ? (
        <p id={textId} className="mt-0.5 text-xs leading-snug text-text-muted">
          {props.text}
        </p>
      ) : null}
    </div>
  );
}
