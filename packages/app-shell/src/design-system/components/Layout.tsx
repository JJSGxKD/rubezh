import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { t } from "../../i18n";
import { IconButton } from "./Button";

/**
 * Каркас экрана: верхняя панель, прокручиваемое тело, опциональное дно.
 *
 * Отступы безопасной зоны берутся из `--app-inset-*`, а не из вычислений в
 * компонентах: кто и как их заполняет — забота адаптера
 * (docs/27-design-system-and-app-shell.md §5.1).
 */
export interface ScreenProps {
  title?: string;
  onBack?: () => void;
  /** действия справа в верхней панели */
  actions?: ReactNode;
  children: ReactNode;
  /** закреплённое дно: основное действие экрана видно без прокрутки */
  footer?: ReactNode;
}

export function Screen(props: ScreenProps): ReactNode {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {props.title === undefined && props.onBack === undefined && props.actions === undefined ? null : (
        <TopBar title={props.title} onBack={props.onBack} actions={props.actions} />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
        {props.children}
      </div>
      {props.footer === undefined ? null : (
        <div className="border-t border-border bg-surface/80 px-4 py-3 pb-[calc(0.75rem+var(--app-inset-bottom))]">
          {props.footer}
        </div>
      )}
    </div>
  );
}

export interface TopBarProps {
  title?: string;
  onBack?: () => void;
  actions?: ReactNode;
}

export function TopBar(props: TopBarProps): ReactNode {
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-1 px-2 pt-[var(--app-inset-top)]">
      {props.onBack === undefined ? (
        <span className="size-11" />
      ) : (
        <IconButton label={t("app.back")} onClick={props.onBack}>
          <ChevronLeft size={22} />
        </IconButton>
      )}
      <h1 className="min-w-0 flex-1 truncate font-display text-lg text-text">{props.title}</h1>
      <div className="flex items-center gap-1">{props.actions}</div>
    </header>
  );
}

export interface TabItem {
  id: string;
  label: string;
  icon: ReactNode;
  /** «скоро» или число — бейдж поверх иконки */
  badge?: string;
}

export interface TabBarProps {
  items: readonly TabItem[];
  activeId: string | null;
  onSelect(id: string): void;
}

export function TabBar(props: TabBarProps): ReactNode {
  return (
    <nav className="flex shrink-0 border-t border-border bg-surface pb-[var(--app-inset-bottom)]">
      {props.items.map((item) => {
        const active = item.id === props.activeId;
        return (
          <button
            key={item.id}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => props.onSelect(item.id)}
            className={[
              "relative flex min-h-14 flex-1 flex-col items-center justify-center gap-1",
              "transition-colors duration-(--duration-fast) ease-base",
              active ? "text-accent" : "text-text-muted",
            ].join(" ")}
          >
            {item.icon}
            <span className="text-xs">{item.label}</span>
            {item.badge === undefined ? null : (
              <span className="absolute top-2 right-[22%] rounded-full bg-surface-raised px-1.5 text-[10px] text-text-muted">
                {item.badge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

/** Колонка контента: на широком экране игра не растягивается на весь монитор. */
export function ContentColumn(props: { children: ReactNode }): ReactNode {
  return <div className="mx-auto w-full max-w-[480px]">{props.children}</div>;
}

export function SectionTitle(props: { children: ReactNode }): ReactNode {
  return (
    <h2 className="mt-6 mb-2 font-display text-xs tracking-wide text-text-muted uppercase">
      {props.children}
    </h2>
  );
}
