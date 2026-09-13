import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/**
 * Строка списка: иконка, заголовок, подпись и одно из окончаний — значение,
 * переключатель или стрелка. Один компонент вместо трёх похожих: настройки и
 * диагностика состоят из него целиком.
 */
export interface ListItemProps {
  title: string;
  hint?: string;
  icon?: ReactNode;
  value?: string;
  onClick?: () => void;
  toggle?: { checked: boolean; onChange: () => void; disabled?: boolean };
  disabled?: boolean;
}

export function ListItem(props: ListItemProps): ReactNode {
  const interactive = props.onClick !== undefined;
  const body = (
    <>
      {props.icon === undefined ? null : (
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-raised text-text-muted">
          {props.icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text">{props.title}</span>
        {props.hint === undefined ? null : (
          <span className="mt-0.5 block text-xs text-text-muted">{props.hint}</span>
        )}
      </span>
      {props.value === undefined ? null : (
        <span className="shrink-0 font-display text-sm text-text-muted tabular-nums">
          {props.value}
        </span>
      )}
      {props.toggle === undefined ? null : (
        <Toggle
          checked={props.toggle.checked}
          onChange={props.toggle.onChange}
          disabled={props.toggle.disabled}
          label={props.title}
        />
      )}
      {interactive ? <ChevronRight size={18} className="shrink-0 text-text-disabled" /> : null}
    </>
  );

  const className = [
    "flex min-h-14 w-full items-center gap-3 bg-surface px-4 py-3 text-left",
    "transition-colors duration-(--duration-fast) ease-base",
    interactive ? "active:bg-surface-raised" : "",
    props.disabled === true ? "opacity-50" : "",
  ].join(" ");

  if (!interactive) return <div className={className}>{body}</div>;

  return (
    <button type="button" disabled={props.disabled} onClick={props.onClick} className={className}>
      {body}
    </button>
  );
}

export interface ToggleProps {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
}

/**
 * Переключатель. Недоступный — с подписью рядом, а не просто серый: состояние
 * не передаётся только цветом (docs/27-design-system-and-app-shell.md §4.4).
 */
export function Toggle(props: ToggleProps): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onChange}
      className={[
        "relative h-8 w-13 shrink-0 rounded-pill",
        "transition-colors duration-(--duration-base) ease-base",
        props.checked ? "fill-accent" : "surface-sunken",
        props.disabled === true ? "opacity-40" : "",
      ].join(" ")}
    >
      <span
        aria-hidden="true"
        className={[
          "absolute top-1 left-1 size-6 rounded-full shadow-button",
          "transition-transform duration-(--duration-base) ease-spring",
          props.checked ? "translate-x-5 bg-on-accent" : "translate-x-0 bg-text-muted",
        ].join(" ")}
      />
    </button>
  );
}

/** Группа строк с общим фоном: список настроек читается как один блок. */
export function ListGroup(props: { children: ReactNode }): ReactNode {
  return (
    <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border shadow-card">
      {props.children}
    </div>
  );
}
