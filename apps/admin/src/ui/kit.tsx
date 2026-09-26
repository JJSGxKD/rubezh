import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import type { ApiError } from "../api/client";

/**
 * Компоненты панели — свои, а не из игры (docs/29-admin-panel.md §4):
 * десктоп, плотные таблицы, формы с клавиатуры. Цвета, шрифты и радиусы — из
 * общего пакета токенов через утилиты Tailwind.
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

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-text-muted">{label}</span>
      {children}
      {hint === undefined ? null : <span className="text-xs text-text-disabled">{hint}</span>}
    </label>
  );
}

export function Panel({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-md border border-border bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
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
                {column.title}
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

export function KeyValue({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-text-muted">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
