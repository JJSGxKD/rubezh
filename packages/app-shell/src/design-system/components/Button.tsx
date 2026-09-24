import type { ReactNode } from "react";
import { uiFeedback } from "../../state/ui-feedback";

/**
 * Кнопка. Минимальная область нажатия — 44×44 CSS px, даже если сама кнопка
 * выглядит меньше (docs/27-design-system-and-app-shell.md §4.6).
 *
 * Объём — из токенов: заливка с бликом и кромка снизу. При нажатии кнопка
 * «проседает» сдвигом, а не сменой тени: анимируется только transform (§3.3).
 *
 * Отклик на нажатие — ещё и тактильный: там, где площадка его даёт и игрок не
 * выключил вибрацию в настройках (§4.5).
 */
/** `stars` — оплата звёздами Telegram: вторичная кнопка в цвете Stars. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "stars";
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
  /** «дышащий» ореол — только у одного действия на экране, иначе он ничего не выделяет */
  glow?: boolean;
  ariaLabel?: string;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  ghost: "bg-transparent text-text-muted active:bg-surface-raised",
  danger: "btn-danger",
  stars: "btn-stars",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  m: "min-h-12 rounded-md px-5 text-base font-semibold",
  l: "min-h-16 rounded-lg px-6 text-lg font-bold tracking-wide uppercase",
};

export function Button(props: ButtonProps): ReactNode {
  const { variant = "primary", size = "m", disabled = false, loading = false } = props;
  const inactive = disabled || loading;

  const handleClick = (): void => {
    if (inactive) return;
    uiFeedback(size === "l" ? "primary" : "tap");
    props.onClick?.();
  };

  return (
    <button
      type="button"
      aria-label={props.ariaLabel}
      aria-busy={loading}
      disabled={inactive}
      onClick={handleClick}
      className={[
        "relative isolate inline-flex items-center justify-center gap-2 font-display",
        "transition-transform duration-(--duration-fast) ease-base",
        "active:translate-y-0.5 active:scale-[0.98] disabled:opacity-45 disabled:active:translate-y-0 disabled:active:scale-100",
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        props.block === true ? "w-full" : "",
      ].join(" ")}
    >
      {props.glow === true && !inactive ? (
        <span
          aria-hidden="true"
          className="halo-accent pointer-events-none absolute -inset-3 -z-10 animate-glow rounded-[inherit]"
        />
      ) : null}
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
  /** «назад» звучит иначе, чем нажатие: шаг вглубь и шаг обратно различаются на слух */
  feedback?: "tap" | "back";
}

export function IconButton(props: IconButtonProps): ReactNode {
  const handleClick = (): void => {
    if (props.disabled === true) return;
    uiFeedback(props.feedback ?? "tap");
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
        "transition-[transform,color] duration-(--duration-fast) ease-base",
        "active:scale-90 active:text-text disabled:opacity-40",
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
      className="size-5 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}
