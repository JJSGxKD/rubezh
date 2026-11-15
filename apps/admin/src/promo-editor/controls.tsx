import { useEffect, useState, type ReactNode } from "react";
import { Input } from "../ui/kit";

/**
 * Мелкие поля панели свойств редактора промо (tasks/T-0274): число с
 * пределами, выбор цвета из палитры пресета, переключатель из нескольких
 * кнопок. Свои, а не общие: у общих `Field` весь блок — подпись, и нажатие на
 * неё нажимало бы первую кнопку внутри.
 */

export function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  // Черновик строкой: «1.» и пустое поле при наборе не должны превращаться в число на лету.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const parsed = Number(draft.replace(",", "."));
  const valid = draft.trim() !== "" && Number.isFinite(parsed) && parsed >= min && parsed <= max;
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-text-muted">{label}</span>
      <Input
        inputMode="decimal"
        value={draft}
        aria-invalid={!valid}
        title={`От ${String(min)} до ${String(max)}`}
        className={`w-full tabular-nums ${valid ? "" : "border-danger"}`}
        onChange={(event) => {
          setDraft(event.target.value);
          const next = Number(event.target.value.replace(",", "."));
          if (event.target.value.trim() !== "" && Number.isFinite(next) && next >= min && next <= max) onChange(Math.round(next * 100) / 100);
        }}
        onBlur={() => setDraft(String(value))}
      />
    </label>
  );
}

/** Цвет документа: из палитры пресета; команде ещё и любой — квадратом выбора браузера. */
export function ColorField({ label, value, palette, free, onChange, allowEmpty }: { label: string; value: string | undefined; palette: readonly string[]; free: boolean; onChange: (color: string | undefined) => void; allowEmpty?: boolean }) {
  const current = value?.toLowerCase();
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-text-muted">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {allowEmpty === true ? (
          <button
            type="button"
            aria-pressed={value === undefined}
            aria-label={`${label}: нет`}
            title="Нет"
            onClick={() => onChange(undefined)}
            className={`h-7 min-w-7 rounded-sm border px-1.5 text-xs ${value === undefined ? "border-accent text-text" : "border-border text-text-muted hover:border-border-strong"}`}
          >
            нет
          </button>
        ) : null}
        {palette.map((color) => (
          <button
            key={color}
            type="button"
            aria-pressed={current === color.toLowerCase()}
            aria-label={`${label}: ${color}`}
            title={color}
            onClick={() => onChange(color.toLowerCase())}
            style={{ background: color }}
            className={`h-7 w-7 rounded-sm border-2 ${current === color.toLowerCase() ? "border-accent" : "border-border hover:border-border-strong"}`}
          />
        ))}
        {free ? (
          <input
            type="color"
            aria-label={`${label}: свой цвет`}
            title="Свой цвет"
            value={value ?? "#000000"}
            onChange={(event) => onChange(event.target.value.toLowerCase())}
            className="h-7 w-9 cursor-pointer rounded-sm border border-border bg-surface-sunken p-0.5"
          />
        ) : null}
        {palette.length === 0 && !free ? <span className="text-xs text-text-muted">В палитре пресета нет цветов</span> : null}
      </div>
    </div>
  );
}

export function Segmented<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: readonly { value: T; title: string; content: ReactNode }[]; onChange: (value: T) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-text-muted">{label}</span>
      <div role="group" aria-label={label} className="inline-flex overflow-hidden rounded-sm border border-border">
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={option.value === value}
            title={option.title}
            aria-label={option.title}
            onClick={() => onChange(option.value)}
            className={`flex h-8 min-w-9 items-center justify-center px-2 text-xs ${option.value === value ? "bg-accent text-on-accent" : "bg-surface-sunken text-text-muted hover:text-text"}`}
          >
            {option.content}
          </button>
        ))}
      </div>
    </div>
  );
}

export function IconButton({ label, onClick, disabled, pressed, children }: { label: string; onClick: () => void; disabled?: boolean; pressed?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      onClick={onClick}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border text-text-muted transition-colors hover:text-text disabled:cursor-not-allowed disabled:opacity-40 ${pressed === true ? "border-accent text-text" : "border-transparent hover:border-border"}`}
    >
      {children}
    </button>
  );
}
