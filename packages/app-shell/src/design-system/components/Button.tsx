import type { ReactNode } from "react";
import { useShell } from "../../state/shell";
import { useSettings } from "../../state/settings";

/**
 * Кнопка. Минимальная область нажатия — 44×44 CSS px, даже если сама кнопка
 * выглядит меньше (docs/27-design-system-and-app-shell.md §4.6).
 *
 * Отклик на нажатие — ещё и тактильный: там, где площадка его даёт и игрок не
 * выключил вибрацию в настройках (§4.5).
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "m" | "l";

export interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  /** растянуть на всю ширину — основное действие экрана */
  block?: boolean;
  ariaLabel?: string;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent active:bg-accent-pressed",
  secondary: "bg-surface-raised text-text border border-border active:bg-surface",
  ghost: "bg-transparent text-text-muted active:bg-surface",
  danger: "bg-transparent text-danger border border-danger/40 active:bg-danger/10",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  m: "min-h-11 px-4 text-sm",
  l: "min-h-14 px-5 text-base",
};

export function Button(props: ButtonProps): ReactNode {
  const { variant = "primary", size = "m", disabled = false, loading = false } = props;
  const haptics = useSettings((state) => state.haptics);

  const handleClick = (): void => {
    if (disabled || loading) return;
    if (haptics) useShell.getState().adapter.haptic("light");
    props.onClick?.();
  };

  return (
    <button
      type="button"
      aria-label={props.ariaLabel}
      aria-busy={loading}
      disabled={disabled || loading}
      onClick={handleClick}
      className={[
        "inline-flex items-center justify-center gap-2 rounded-md font-display font-medium",
        "transition-[transform,background-color] duration-(--duration-fast) ease-base",
        "active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100",
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        props.block === true ? "w-full" : "",
      ].join(" ")}
    >
      {loading ? <Spinner /> : props.children}
    </button>
  );
}

export interface IconButtonProps {
  children: ReactNode;
  /** подпись для скринридера обязательна: иконка сама по себе ничего не говорит */
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}

export function IconButton(props: IconButtonProps): ReactNode {
  const haptics = useSettings((state) => state.haptics);

  const handleClick = (): void => {
    if (props.disabled === true) return;
    if (haptics) useShell.getState().adapter.haptic("light");
    props.onClick?.();
  };

  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={handleClick}
      className={[
        "inline-flex size-11 items-center justify-center rounded-md text-text-muted",
        "transition-colors duration-(--duration-fast) ease-base",
        "active:bg-surface disabled:opacity-40",
      ].join(" ")}
    >
      {props.children}
    </button>
  );
}

/** Анимация только transform — правило производительности оболочки (§3.3). */
function Spinner(): ReactNode {
  return (
    <span
      aria-hidden="true"
      className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}
