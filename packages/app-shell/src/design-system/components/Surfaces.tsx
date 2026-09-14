import { useEffect, type CSSProperties, type ReactNode } from "react";
import { Check, Lock } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "./Button";
import { Badge } from "./Data";

/**
 * Задержка лесенки появления: n-й элемент выезжает на n шагов позже. Шаг — из
 * токенов, число здесь только порядковый номер.
 */
export function staggerStyle(index: number): CSSProperties {
  return { animationDelay: `calc(var(--stagger-step) * ${index})` };
}

/** Цветная кромка карточки: что это за предмет, видно до чтения текста. */
export type CardStripe = "weapon" | "passive" | "accent" | "info";

const STRIPE_CLASS: Record<CardStripe, string> = {
  weapon: "bg-weapon",
  passive: "bg-passive",
  accent: "bg-accent",
  info: "bg-info",
};

/** Карточка: обычная и выбираемая (апгрейды, оружие, магазин). */
export interface CardProps {
  children: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  disabled?: boolean;
  stripe?: CardStripe;
  /** порядковый номер в лесенке появления; без него карточка не анимируется */
  appearIndex?: number;
  /** уменьшенные поля — для карточек, которые обязаны помещаться втроём в модалку */
  compact?: boolean;
}

export function Card(props: CardProps): ReactNode {
  const interactive = props.onClick !== undefined;
  const selected = props.selected === true;
  const className = [
    // flex-col: кнопка по умолчанию центрирует содержимое по вертикали, и в
    // ряду карточек разной длины текст «плавал» бы на разной высоте.
    "relative flex w-full flex-col overflow-hidden rounded-lg text-left",
    props.compact === true ? "p-3" : "p-4",
    "transition-transform duration-(--duration-fast) ease-base",
    selected ? "surface-card-selected" : "surface-card",
    interactive ? "active:scale-[0.98]" : "",
    props.disabled === true ? "opacity-60" : "",
    props.appearIndex === undefined ? "" : "animate-rise-in",
  ].join(" ");
  const style = props.appearIndex === undefined ? undefined : staggerStyle(props.appearIndex);

  const body = (
    <>
      {props.stripe === undefined ? null : (
        <span
          aria-hidden="true"
          className={`absolute inset-y-0 left-0 w-1 ${STRIPE_CLASS[props.stripe]}`}
        />
      )}
      {/* Выбор отмечен значком, а не только цветом рамки (§4.4). */}
      {selected ? (
        <span
          aria-hidden="true"
          className="absolute top-3 right-3 inline-flex size-6 animate-pop-in items-center justify-center rounded-full bg-accent text-on-accent"
        >
          <Check size={16} strokeWidth={3} />
        </span>
      ) : null}
      {props.children}
    </>
  );

  if (!interactive) {
    return (
      <div className={className} style={style}>
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={props.selected}
      disabled={props.disabled}
      onClick={props.onClick}
      className={className}
      style={style}
    >
      {body}
    </button>
  );
}

/**
 * Оверлей поверх остановленной канвы. Затемнение, а не размытие:
 * `backdrop-filter` на бюджетном Android стоит дороже всего мира забега
 * (docs/27-design-system-and-app-shell.md §3.3, правило 4).
 */
export interface ModalProps {
  title?: string;
  /** значок над заголовком — у модалок забега он заменяет иллюстрацию */
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** снизу — лист подтверждения, по центру — модалка забега */
  placement?: "center" | "bottom";
  /** широкая — для трёх карточек в ряд в ландшафте (§5.3) */
  size?: "m" | "l";
  /**
   * Закрыть тапом по затемнению и клавишей Escape. Только у листов и
   * подтверждений: модалки забега так не закрываются — промах пальцем мимо
   * карточки улучшения не должен ничего делать.
   */
  onDismiss?: () => void;
}

export function Modal(props: ModalProps): ReactNode {
  const bottom = props.placement === "bottom";
  const wide = props.size === "l";
  const { onDismiss } = props;

  useEffect(() => {
    if (onDismiss === undefined) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={props.title}
      className={[
        "absolute inset-0 flex px-4",
        "pt-[calc(1rem+var(--app-inset-top))] pb-[calc(1rem+var(--app-inset-bottom))]",
        "pr-[calc(1rem+var(--app-inset-right))] pl-[calc(1rem+var(--app-inset-left))]",
        bottom ? "items-end justify-center" : "items-center justify-center",
      ].join(" ")}
      style={{ zIndex: "var(--z-modal)" }}
    >
      <div aria-hidden="true" className="absolute inset-0 animate-fade-in bg-bg/80" onClick={onDismiss} />
      <div
        className={[
          "surface-panel relative max-h-full w-full overflow-y-auto overscroll-contain rounded-xl p-5 short:p-4 landscape:p-4",
          wide ? "max-w-[420px] landscape:max-w-[760px]" : "max-w-[420px]",
          bottom ? "animate-sheet-in" : "animate-pop-in",
        ].join(" ")}
      >
        {/* На невысоком экране и в ландшафте значок прячется: каждая строка на
            счету — карточки выбора и кнопка «Ещё раз» не должны уходить под
            прокрутку (§5.3). */}
        {props.icon === undefined ? null : (
          <div className="mb-2 flex justify-center short:hidden landscape:hidden">
            <IconEmblem>{props.icon}</IconEmblem>
          </div>
        )}
        {props.title === undefined ? null : (
          <h2
            className={[
              "mb-3 font-display text-2xl font-bold text-text short:mb-2 short:text-xl landscape:mb-1 landscape:text-xl",
              props.icon === undefined ? "" : "text-center",
            ].join(" ")}
          >
            {props.title}
          </h2>
        )}
        {props.children}
        {props.footer === undefined ? null : <div className="mt-5 grid gap-2">{props.footer}</div>}
      </div>
    </div>
  );
}

/**
 * Значок в светящемся круге: заменяет иллюстрацию, пока нет ассетов, и держит
 * у заглушек и модалок единый «игровой» вид.
 */
export function IconEmblem(props: {
  children: ReactNode;
  tone?: "accent" | "info" | "muted";
  size?: "m" | "l";
}): ReactNode {
  const tone = props.tone ?? "accent";
  const large = props.size === "l";

  return (
    <span className={`relative isolate inline-flex ${large ? "size-20" : "size-14"}`}>
      {tone === "muted" ? null : (
        <span
          aria-hidden="true"
          className={[
            "pointer-events-none absolute -inset-4 -z-10 animate-glow rounded-full",
            tone === "accent" ? "halo-accent" : "halo-info",
          ].join(" ")}
        />
      )}
      <span
        className={[
          "surface-card inline-flex size-full items-center justify-center rounded-full",
          tone === "accent" ? "text-accent" : tone === "info" ? "text-info" : "text-text-muted",
        ].join(" ")}
      >
        {props.children}
      </span>
    </span>
  );
}

/**
 * Раздел в разработке. Не пустое место: экран объясняет, что здесь будет, —
 * иначе для тестера это баг, а не заглушка (§6).
 */
export interface StubProps {
  icon?: ReactNode;
  title: string;
  text: string;
  children?: ReactNode;
}

export function StubScreen(props: StubProps): ReactNode {
  return (
    <div className="flex animate-rise-in flex-col items-center gap-3 px-2 py-10 text-center">
      {props.icon === undefined ? null : (
        <IconEmblem tone="info" size="l">
          {props.icon}
        </IconEmblem>
      )}
      <h2 className="mt-2 font-display text-xl font-bold text-text">{props.title}</h2>
      <span className="rounded-pill bg-warning/15 px-3 py-1 font-display text-xs font-semibold tracking-wide text-warning uppercase">
        {t("app.inDevelopment")}
      </span>
      <p className="max-w-[320px] text-sm text-text-muted">{props.text}</p>
      {props.children}
    </div>
  );
}

/**
 * Компактная пометка «в разработке» над разделом, который уже нарисован как
 * настоящий: большая заглушка закрыла бы сам макет, ради которого раздел и
 * открывают.
 */
export function StubNotice(props: { text: string }): ReactNode {
  return (
    <div className="surface-sunken flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2.5">
      <Badge tone="warning">
        <Lock size={12} aria-hidden="true" />
        {t("app.inDevelopment")}
      </Badge>
      <p className="min-w-0 flex-1 basis-48 text-xs text-text-muted">{props.text}</p>
    </div>
  );
}

/** Сообщение об ошибке с одним действием: без него игрок упирается в тупик. */
export function ErrorState(props: { text: string; onRetry?: () => void }): ReactNode {
  return (
    <div className="flex animate-rise-in flex-col items-center gap-4 px-2 py-10 text-center">
      <h2 className="font-display text-xl font-bold text-danger">{t("error.title")}</h2>
      <p className="max-w-[320px] text-sm text-text-muted">{props.text}</p>
      {props.onRetry === undefined ? null : (
        <Button onClick={props.onRetry}>{t("app.retry")}</Button>
      )}
    </div>
  );
}
