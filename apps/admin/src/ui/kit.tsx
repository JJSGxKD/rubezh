import { useEffect, useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import type { ApiError } from "../api/client";

/**
 * Базовые компоненты панели (docs/29-admin-panel.md §4): десктоп, плотные
 * таблицы, формы с клавиатуры. Цвета, шрифты и радиусы — из общего пакета
 * токенов через утилиты Tailwind. Сложное поведение — диалоги, выбор
 * карточками, уведомления — берётся из библиотек (`dialog.tsx`,
 * `choice.tsx`, `toast.tsx`) под теми же токенами.
 */

type Tone = "neutral" | "accent" | "danger" | "success" | "warning" | "info";

const BUTTON_TONES = {
  primary: "bg-accent text-on-accent hover:bg-accent-pressed",
  secondary: "bg-surface-raised text-text border border-border hover:border-border-strong",
  danger: "bg-danger/15 text-danger border border-danger/40 hover:bg-danger/25",
} as const;

export function Button({ tone = "secondary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: keyof typeof BUTTON_TONES }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_TONES[tone]} ${className}`}
    />
  );
}

const FIELD = "rounded-sm border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-text placeholder:text-text-disabled focus:border-accent focus:outline-none";

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${FIELD} ${className}`} />;
}

export function TextArea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${FIELD} ${className}`} />;
}

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${FIELD} ${className}`} />;
}

/** Ширина подсказки и отступ от края окна, px: подсказка не уезжает за экран. */
const HELP_WIDTH = 288;
const HELP_MARGIN = 8;

/**
 * Пояснение к полю, колонке или разделу: значок «?», текст — по наведению,
 * фокусу с клавиатуры или нажатию (нажатие закрепляет). Не кнопка, а элемент
 * с ролью кнопки: в `<label>` поля настоящая кнопка перехватила бы подпись у
 * поля ввода.
 *
 * Подсказка — `fixed` от значка: таблицы лежат в контейнере с прокруткой, и
 * обычное позиционирование обрезало бы её по краю таблицы.
 *
 * Текст — что это и зачем, а не пересказ подписи: «Место в круге» — как
 * выдача выбирает сеть и что будет при отказе.
 */
export function Help({ text }: { text: string }) {
  const id = useId();
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const [pinned, setPinned] = useState(false);

  const show = (target: HTMLElement): void => {
    const rect = target.getBoundingClientRect();
    setAt({ left: Math.max(HELP_MARGIN, Math.min(rect.left, window.innerWidth - HELP_WIDTH - HELP_MARGIN)), top: rect.bottom + 6 });
  };
  const hide = (): void => {
    setAt(null);
    setPinned(false);
  };

  // Прокрутка уводит значок из-под подсказки — закрытая подсказка лучше висящей в стороне.
  useEffect(() => {
    if (at === null) return;
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  }, [at === null]);

  const toggle = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>): void => {
    // Нажатие внутри подписи поля не должно уводить фокус в поле ввода.
    event.preventDefault();
    event.stopPropagation();
    if (pinned) {
      hide();
      return;
    }
    show(event.currentTarget);
    setPinned(true);
  };

  return (
    <span className="inline-flex align-middle">
      <span
        role="button"
        tabIndex={0}
        aria-label="Пояснение"
        aria-describedby={id}
        aria-expanded={at !== null}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") toggle(event);
          else if (event.key === "Escape") hide();
        }}
        onMouseEnter={(event) => show(event.currentTarget)}
        onMouseLeave={() => {
          if (!pinned) setAt(null);
        }}
        onFocus={(event) => show(event.currentTarget)}
        onBlur={hide}
        className="inline-flex size-4 cursor-help items-center justify-center rounded-full border border-border-strong text-[10px] leading-none font-semibold text-text-muted select-none hover:border-accent hover:text-accent focus-visible:border-accent focus-visible:text-accent focus-visible:outline-none"
      >
        ?
      </span>
      {/* В разметке всегда: на него ссылается `aria-describedby`, а скрыт он классом. */}
      <span
        role="tooltip"
        id={id}
        style={at === null ? undefined : { left: at.left, top: at.top, width: HELP_WIDTH }}
        className={`pointer-events-none fixed z-50 rounded-sm border border-border-strong bg-surface-raised px-2.5 py-2 text-left text-xs font-normal leading-snug tracking-normal whitespace-normal normal-case text-text shadow-panel ${at === null ? "hidden" : "block"}`}
      >
        {text}
      </span>
    </span>
  );
}

/** Поле формы: подпись, пояснение, подсказка и ошибка проверки — у самого поля, а не общим списком. */
export function Field({ label, hint, help, error, children }: { label: string; hint?: string; help?: string; error?: string | undefined; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-xs text-text-muted">
        {label}
        {help === undefined ? null : <Help text={help} />}
      </span>
      {children}
      {error === undefined ? null : (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
      {hint === undefined ? null : <span className="text-xs text-text-disabled">{hint}</span>}
    </label>
  );
}

export function Panel({ title, help, actions, children }: { title: string; help?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          {title}
          {help === undefined ? null : <Help text={help} />}
        </h2>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

const BADGE_TONES: Record<Tone, string> = {
  neutral: "bg-surface-raised text-text-muted",
  accent: "bg-accent/15 text-accent",
  danger: "bg-danger/15 text-danger",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  info: "bg-info/15 text-info",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-pill px-2 py-0.5 text-xs ${BADGE_TONES[tone]}`}>{children}</span>;
}

export function Notice({ tone = "danger", children }: { tone?: "danger" | "info" | "success"; children: ReactNode }) {
  const tones = { danger: "border-danger/40 text-danger", info: "border-info/40 text-info", success: "border-success/40 text-success" };
  return <p className={`rounded-sm border bg-surface-sunken px-3 py-2 text-sm ${tones[tone]}`}>{children}</p>;
}

export function ErrorNotice({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <Notice>{error.message}</Notice>
      {onRetry === undefined ? null : <Button onClick={onRetry}>Повторить</Button>}
    </div>
  );
}

export function Loading() {
  return <p className="text-sm text-text-muted">Загрузка…</p>;
}

export interface Column<T> {
  title: string;
  render: (row: T) => ReactNode;
  /** числа — вправо: разряды должны стоять друг под другом */
  align?: "left" | "right";
  /** что значит колонка — значок «?» рядом с заголовком */
  help?: string;
}

export function DataTable<T>({ columns, rows, rowKey, onRowClick, empty = "Пусто" }: { columns: Column<T>[]; rows: readonly T[]; rowKey: (row: T) => string; onRowClick?: (row: T) => void; empty?: string }) {
  if (rows.length === 0) return <p className="text-sm text-text-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-text-muted">
            {columns.map((column) => (
              <th key={column.title} className={`px-2 py-1.5 font-medium ${column.align === "right" ? "text-right" : ""}`}>
                {column.help === undefined ? (
                  column.title
                ) : (
                  <span className="inline-flex items-center gap-1">
                    {column.title}
                    <Help text={column.help} />
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick === undefined ? undefined : () => onRowClick(row)}
              className={`border-b border-border/60 ${onRowClick === undefined ? "" : "cursor-pointer hover:bg-surface-raised"}`}
            >
              {columns.map((column) => (
                <td key={column.title} className={`px-2 py-1.5 align-top ${column.align === "right" ? "text-right" : ""}`}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Строка: подпись, значение и, если нужно, пояснение к подписи. */
export function KeyValue({ items }: { items: ([string, ReactNode] | [string, ReactNode, string])[] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      {items.map(([label, value, help]) => (
        <div key={label} className="contents">
          <dt className="flex items-center gap-1.5 text-text-muted">
            {label}
            {help === undefined ? null : <Help text={help} />}
          </dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
