import type { ReactNode } from "react";
import { t } from "../../i18n";
import { Button } from "./Button";

/** Карточка: обычная и выбираемая (апгрейды, оружие, магазин). */
export interface CardProps {
  children: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  disabled?: boolean;
}

export function Card(props: CardProps): ReactNode {
  const interactive = props.onClick !== undefined;
  const className = [
    "w-full rounded-lg border p-4 text-left",
    "transition-[transform,border-color] duration-(--duration-fast) ease-base",
    props.selected === true ? "border-accent bg-surface-raised" : "border-border bg-surface",
    interactive ? "active:scale-[0.99]" : "",
    props.disabled === true ? "opacity-50" : "",
  ].join(" ");

  if (!interactive) return <div className={className}>{props.children}</div>;

  return (
    <button
      type="button"
      aria-pressed={props.selected}
      disabled={props.disabled}
      onClick={props.onClick}
      className={className}
    >
      {props.children}
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
  children: ReactNode;
  footer?: ReactNode;
  /** снизу — лист подтверждения, по центру — модалка забега */
  placement?: "center" | "bottom";
}

export function Modal(props: ModalProps): ReactNode {
  const bottom = props.placement === "bottom";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={props.title}
      className={[
        "absolute inset-0 flex bg-bg/85 px-4",
        "pt-[var(--app-inset-top)] pb-[var(--app-inset-bottom)]",
        bottom ? "items-end pb-[calc(1rem+var(--app-inset-bottom))]" : "items-center justify-center",
      ].join(" ")}
      style={{ zIndex: "var(--z-modal)" }}
    >
      <div className="max-h-full w-full max-w-[420px] overflow-y-auto rounded-lg border border-border bg-surface p-5">
        {props.title === undefined ? null : (
          <h2 className="mb-3 font-display text-xl text-text">{props.title}</h2>
        )}
        {props.children}
        {props.footer === undefined ? null : <div className="mt-5 grid gap-2">{props.footer}</div>}
      </div>
    </div>
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
    <div className="flex flex-col items-center gap-3 px-2 py-10 text-center">
      {props.icon === undefined ? null : <div className="text-text-disabled">{props.icon}</div>}
      <h2 className="font-display text-lg text-text">{props.title}</h2>
      <span className="rounded-md bg-surface-raised px-2 py-1 text-xs text-warning">
        {t("app.inDevelopment")}
      </span>
      <p className="max-w-[320px] text-sm text-text-muted">{props.text}</p>
      {props.children}
    </div>
  );
}

/** Сообщение об ошибке с одним действием: без него игрок упирается в тупик. */
export function ErrorState(props: { text: string; onRetry?: () => void }): ReactNode {
  return (
    <div className="flex flex-col items-center gap-4 px-2 py-10 text-center">
      <h2 className="font-display text-lg text-danger">{t("error.title")}</h2>
      <p className="max-w-[320px] text-sm text-text-muted">{props.text}</p>
      {props.onRetry === undefined ? null : (
        <Button onClick={props.onRetry}>{t("app.retry")}</Button>
      )}
    </div>
  );
}
