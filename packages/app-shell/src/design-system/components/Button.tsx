import type { ReactNode } from "react";
import { trackClick } from "../../state/ui-clicks";
import { uiFeedback } from "../../state/ui-feedback";
import { CutFrame } from "./CutFrame";

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
/** `s` — компактная кнопка в строке плашки; основное действие экрана — `m` и `l`. */
export type ButtonSize = "s" | "m" | "l";

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
  /**
   * Срезанный угол с рамкой по срезу (design/README.md) — только у главной
   * кнопки экрана: `variant="primary"` или `"stars"` (главная покупка
   * магазина). У других вариантов игнорируется.
   */
  cut?: boolean;
  /**
   * Блик: раз в несколько секунд по кнопке пробегает полоса света — у
   * главного действия экрана, которое должно звать («Играть»). Только
   * `transform` и `opacity`; при «меньше движения» блика нет.
   */
  shine?: boolean;
  ariaLabel?: string;
  /**
   * Имя кнопки для события `ui_clicked` (Р141): по смыслу действия — `buy`,
   * `claim`, `share`, — а не по тексту. Экран подставляется сам.
   */
  track: string;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  ghost: "bg-transparent text-text-muted active:bg-surface-raised",
  danger: "btn-danger",
  stars: "btn-stars",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  s: "min-h-9 rounded-md px-2.5 text-xs font-semibold",
  m: "min-h-12 rounded-md px-5 text-base font-semibold",
  l: "min-h-16 rounded-lg px-6 text-lg font-bold tracking-wide uppercase",
};

/**
 * Выключенная главная кнопка — нейтральная, а не бледная оранжевая: заливка
 * акцента на 45% прозрачности над тёмным фоном становится бурой и читается
 * как «сломано», а не «пока нельзя». Пока идёт загрузка, кнопка остаётся в
 * своём цвете — действие уже принято.
 */
const RESTING_CLASS = "btn-resting";

/** Варианты с заливкой цвета: у остальных выключенное состояние и так нейтрально. */
function restsNeutral(variant: ButtonVariant): boolean {
  return variant === "primary" || variant === "stars";
}

/** Кнопка со срезом: высота и шрифт те же, что у обычной, а поля и скругление уходят внутрь среза. */
const CUT_BUTTON_CLASS: Record<ButtonSize, string> = {
  s: "min-h-9 text-xs font-semibold",
  m: "min-h-12 text-base font-semibold",
  l: "min-h-16 text-lg font-bold tracking-wide uppercase",
};

const CUT_PADDING_CLASS: Record<ButtonSize, string> = { s: "px-2.5", m: "px-5", l: "px-6" };

/** Скругление кнопки: у обёртки свечения радиуса нет, `inherit` не сработал бы. */
function radiusOf(size: ButtonSize): string {
  return SIZE_CLASS[size].split(" ").find((name) => name.startsWith("rounded-")) ?? "rounded-md";
}

/** Не-главные варианты со `cut` предупреждаем один раз за сессию, а не на каждой отрисовке. */
const warnedCut = new Set<ButtonVariant>();

/**
 * Срез у кнопки — только главное действие экрана: `primary` или кнопка звёзд
 * (главная покупка магазина). Остальным `cut` не нужен: тихо проглотить его
 * значило бы спрятать ошибку вёрстки.
 */
function cutAllowed(variant: ButtonVariant, requested: boolean): boolean {
  if (!requested) return false;
  if (variant === "primary" || variant === "stars") return true;
  if (!warnedCut.has(variant)) {
    warnedCut.add(variant);
    console.warn(`Button: свойство cut работает только у variant="primary" и "stars", у "${variant}" оно игнорируется`);
  }
  return false;
}

export function Button(props: ButtonProps): ReactNode {
  const { variant = "primary", size = "m", disabled = false, loading = false } = props;
  const inactive = disabled || loading;
  const cut = cutAllowed(variant, props.cut === true);
  const resting = disabled && !loading && restsNeutral(variant);

  const handleClick = (): void => {
    if (inactive) return;
    uiFeedback(size === "l" ? "primary" : "tap");
    if (props.track !== undefined) trackClick(props.track);
    props.onClick?.();
  };

  const button = (
    <button
      type="button"
      aria-label={props.ariaLabel}
      aria-busy={loading}
      disabled={inactive}
      onClick={handleClick}
      className={[
        "relative isolate inline-flex items-center justify-center gap-2 font-display",
        "transition-transform duration-(--duration-fast) ease-base",
        "active:translate-y-0.5 active:scale-[0.98] disabled:active:translate-y-0 disabled:active:scale-100",
        resting ? "disabled:opacity-70" : "disabled:opacity-45",
        // Заливку, рамку и скругление у среза рисует `CutFrame` внутри кнопки.
        cut ? (resting ? "text-text-muted" : "") : resting ? RESTING_CLASS : VARIANT_CLASS[variant],
        cut ? CUT_BUTTON_CLASS[size] : SIZE_CLASS[size],
        props.block === true ? "w-full" : "",
      ].join(" ")}
    >
      {cut ? (
        <CutFrame
          tone={resting ? "panel" : variant === "stars" ? "stars" : "primary"}
          size="sm"
          className={`flex flex-1 items-center justify-center gap-2 self-stretch ${CUT_PADDING_CLASS[size]}`}
        >
          {loading ? <Spinner /> : props.children}
          {props.shine === true && !inactive ? <Shine /> : null}
        </CutFrame>
      ) : loading ? (
        <Spinner />
      ) : (
        props.children
      )}
    </button>
  );

  if (props.glow !== true || inactive) return button;

  // Свечение — соседний слой позади кнопки: потомок с отрицательным z-index
  // рисовался бы над её фоном, и фон мигал бы вместе с ореолом.
  return (
    <span className={`relative isolate ${props.block === true ? "flex w-full" : "inline-flex"}`}>
      <span
        aria-hidden="true"
        className={`halo-accent pointer-events-none absolute -inset-3 -z-10 animate-glow ${radiusOf(size)}`}
      />
      {button}
    </span>
  );
}

/**
 * Полоса света по заливке, под надписью: z-index −1 в слое `CutFrame` — тот
 * же, что у заливки, но позже в разметке. Над текстом блик бледнил бы его.
 * Срез `CutFrame` обрезает полосу по форме кнопки.
 */
function Shine(): ReactNode {
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-0 -z-1 overflow-hidden">
      <span
        // Прозрачна вне анимации: при «меньше движения» анимация кончается сразу, и полоса не должна застыть на кнопке.
        className="absolute inset-y-0 left-0 w-1/3 animate-btn-shine opacity-0"
        style={{ backgroundImage: "linear-gradient(90deg, transparent, color-mix(in oklab, var(--color-text) 55%, transparent), transparent)" }}
      />
    </span>
  );
}

export interface IconButtonProps {
  children: ReactNode;
  /** подпись для скринридера обязательна: иконка сама по себе ничего не говорит */
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  /**
   * «назад» звучит иначе, чем нажатие: шаг вглубь и шаг обратно различаются
   * на слух. `null` — кнопка молчит: звук даёт то, что она закрывает, —
   * лист шуршит на закрытии сам.
   */
  feedback?: "tap" | "back" | null;
  /** имя кнопки для события `ui_clicked` (см. `ButtonProps.track`) */
  track: string;
}

export function IconButton(props: IconButtonProps): ReactNode {
  const handleClick = (): void => {
    if (props.disabled === true) return;
    if (props.feedback !== null) uiFeedback(props.feedback ?? "tap");
    if (props.track !== undefined) trackClick(props.track);
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
