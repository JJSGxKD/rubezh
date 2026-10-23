import { useEffect, useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { ChevronRight } from "lucide-react";
import type { ApiError } from "../api/client";
import { useNarrow } from "./use-media";

/**
 * Базовые компоненты панели (docs/29-admin-panel.md §4): десктоп, плотные
 * таблицы, формы с клавиатуры. Цвета, шрифты и радиусы — из общего пакета
 * токенов через утилиты Tailwind. Сложное поведение — диалоги, выбор
 * карточками, уведомления — берётся из библиотек (`dialog.tsx`,
 * `choice.tsx`, `toast.tsx`) под теми же токенами.
 */

type Tone = "neutral" | "accent" | "danger" | "success" | "warning" | "info";

const BUTTON_TONES = {
  // Выключенная главная — нейтральная, а не бледно-оранжевая: бурая кнопка
  // читалась как «нажата» или «грузится», а не как «пока нельзя».
  primary: "bg-accent text-on-accent hover:bg-accent-pressed disabled:bg-surface-raised disabled:text-text-muted disabled:hover:bg-surface-raised",
  secondary: "bg-surface-raised text-text border border-border hover:border-border-strong",
  // Подложка от фона, а не полупрозрачная: на карточке красный текст на ней
  // давал 4,3:1 при пороге 4,5 (docs/27 §4.4).
  danger:
    "bg-[color-mix(in_oklab,var(--color-danger)_8%,var(--color-bg))] text-danger border border-danger/40 hover:bg-[color-mix(in_oklab,var(--color-danger)_14%,var(--color-bg))]",
} as const;

export function Button({ tone = "secondary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: keyof typeof BUTTON_TONES }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors max-md:min-h-10 disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_TONES[tone]} ${className}`}
    />
  );
}

const FIELD = "rounded-sm border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-text placeholder:text-text-disabled focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";

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
      {hint === undefined ? null : <span className="text-xs text-text-muted">{hint}</span>}
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
  accent: "badge-tinted [--badge-tone:var(--color-accent)]",
  danger: "badge-tinted [--badge-tone:var(--color-danger)]",
  success: "badge-tinted [--badge-tone:var(--color-success)]",
  warning: "badge-tinted [--badge-tone:var(--color-warning)]",
  info: "badge-tinted [--badge-tone:var(--color-info)]",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-pill px-2 py-0.5 text-xs ${BADGE_TONES[tone]}`}>{children}</span>;
}

export function Notice({ tone = "danger", children }: { tone?: "danger" | "warning" | "info" | "success"; children: ReactNode }) {
  const tones = { danger: "border-danger/40 text-danger", warning: "border-warning/40 text-warning", info: "border-info/40 text-info", success: "border-success/40 text-success" };
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
  /** главное поле карточки строки на телефоне; по умолчанию — первая колонка */
  primary?: boolean;
  /** не показывать колонку в карточке на телефоне */
  phone?: "hide";
}

/**
 * Раскладка карточки строки на телефоне (tasks/T-0049): главное поле крупно,
 * остальные колонки — парами «название значение», колонки без заголовка
 * (кнопки действий) — в углу карточки.
 */
export function phoneLayout<T>(columns: readonly Column<T>[]): { primary: Column<T>; pairs: Column<T>[]; actions: Column<T>[] } {
  const primary = columns.find((column) => column.primary === true) ?? columns[0];
  if (primary === undefined) throw new Error("В таблице нет колонок");
  const rest = columns.filter((column) => column !== primary);
  return {
    primary,
    pairs: rest.filter((column) => column.phone !== "hide" && column.title !== ""),
    actions: rest.filter((column) => column.title === ""),
  };
}

/**
 * Есть ли что показать в паре карточки. Пустая ячейка в таблице на ПК —
 * норма, а подпись без значения на телефоне читается как поломка.
 */
export function hasPhoneValue(node: ReactNode): boolean {
  if (Array.isArray(node)) return node.some((item) => hasPhoneValue(item as ReactNode));
  return node !== null && node !== undefined && typeof node !== "boolean" && node !== "";
}

export function DataTable<T>({ columns, rows, rowKey, onRowClick, empty = "Пусто" }: { columns: Column<T>[]; rows: readonly T[]; rowKey: (row: T) => string; onRowClick?: (row: T) => void; empty?: string }) {
  const narrow = useNarrow();
  if (rows.length === 0) return <p className="text-sm text-text-muted">{empty}</p>;
  if (narrow) return <PhoneCards columns={columns} rows={rows} rowKey={rowKey} onRowClick={onRowClick} />;
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
              className={`border-b border-border/60 ${onRowClick === undefined ? "" : "cursor-pointer hover:bg-surface-raised/50"}`}
            >
              {columns.map((column) => (
                <td key={column.title} className={`px-2 py-1.5 align-top tabular-nums ${column.align === "right" ? "text-right" : ""}`}>
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

/** Таблица на телефоне — список карточек: боковая прокрутка пальцем неудобна и прячет колонки. */
function PhoneCards<T>({ columns, rows, rowKey, onRowClick }: { columns: readonly Column<T>[]; rows: readonly T[]; rowKey: (row: T) => string; onRowClick: ((row: T) => void) | undefined }) {
  const { primary, pairs, actions } = phoneLayout(columns);
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li
          key={rowKey(row)}
          onClick={onRowClick === undefined ? undefined : () => onRowClick(row)}
          // Перенос: четыре кнопки действий рядом с текстом на 390 не помещаются — уходят строкой ниже.
          className={`flex flex-wrap items-start gap-2 rounded-md border border-border bg-surface px-3 py-2.5 ${onRowClick === undefined ? "" : "cursor-pointer active:bg-surface-raised"}`}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="min-w-0 text-sm font-semibold">{primary.render(row)}</div>
            {pairs.length === 0 ? null : (
              <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                {pairs.map((column) => {
                  const value = column.render(row);
                  if (!hasPhoneValue(value)) return null;
                  return (
                    <div key={column.title} className="flex min-w-0 gap-1.5">
                      <dt className="text-text-muted">{column.title}</dt>
                      <dd className="min-w-0 tabular-nums text-text">{value}</dd>
                    </div>
                  );
                })}
              </dl>
            )}
          </div>
          {actions.length === 0 ? null : (
            <div className="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-1.5" onClick={(event) => event.stopPropagation()}>
              {actions.map((column, index) => (
                <span key={index}>{column.render(row)}</span>
              ))}
            </div>
          )}
          {onRowClick === undefined ? null : <ChevronRight size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-text-disabled" />}
        </li>
      ))}
    </ul>
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
