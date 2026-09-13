import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { t } from "../../i18n";
import { useSettings } from "../../state/settings";
import { useShell } from "../../state/shell";
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
        <div className="px-4 pt-2 pb-[calc(0.75rem+var(--app-inset-bottom))]">
          <div className="mx-auto w-full max-w-[480px]">{props.footer}</div>
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
          <ChevronLeft size={24} />
        </IconButton>
      )}
      <h1 className="min-w-0 flex-1 truncate font-display text-lg font-bold text-text">
        {props.title}
      </h1>
      <div className="flex items-center gap-1">{props.actions}</div>
    </header>
  );
}

export interface TabItem {
  id: string;
  label: string;
  icon: ReactNode;
  /** `dot` — точка «здесь что-то появится»; строка — число или короткая метка */
  badge?: "dot" | string;
}

export interface TabBarProps {
  items: readonly TabItem[];
  activeId: string | null;
  onSelect(id: string): void;
}

export function TabBar(props: TabBarProps): ReactNode {
  const haptics = useSettings((state) => state.haptics);

  return (
    <nav className="shrink-0 border-t border-border bg-surface pb-[var(--app-inset-bottom)]">
      <div className="mx-auto flex w-full max-w-[560px]">
        {props.items.map((item) => {
          const active = item.id === props.activeId;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => {
                if (!active && haptics) useShell.getState().adapter.haptic("light");
                props.onSelect(item.id);
              }}
              className={[
                "relative flex min-h-16 flex-1 flex-col items-center justify-center gap-1",
                "transition-colors duration-(--duration-fast) ease-base",
                active ? "text-accent" : "text-text-muted active:text-text",
              ].join(" ")}
            >
              {/* Подложка активной вкладки проявляется и растёт — только opacity и transform. */}
              <span
                aria-hidden="true"
                className={[
                  "absolute top-2 h-8 w-14 rounded-pill bg-accent/15",
                  "transition-[opacity,transform] duration-(--duration-base) ease-spring",
                  active ? "scale-100 opacity-100" : "scale-50 opacity-0",
                ].join(" ")}
              />
              <span
                className={[
                  "relative transition-transform duration-(--duration-base) ease-spring",
                  active ? "-translate-y-0.5" : "",
                ].join(" ")}
              >
                {item.icon}
                {item.badge === undefined ? null : <TabBadge badge={item.badge} />}
              </span>
              <span className={`relative text-xs ${active ? "font-semibold" : ""}`}>
                {item.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function TabBadge(props: { badge: string }): ReactNode {
  if (props.badge === "dot") {
    return (
      <span aria-hidden="true" className="absolute -top-0.5 -right-1.5 inline-flex size-2.5">
        <span className="absolute inset-0 animate-ping-dot rounded-full bg-accent" />
        <span className="relative size-full rounded-full border-2 border-surface bg-accent" />
      </span>
    );
  }

  return (
    <span className="absolute -top-1.5 -right-3 min-w-5 rounded-pill bg-danger px-1 text-center font-display text-xs font-bold text-text">
      {props.badge}
    </span>
  );
}

/** Колонка контента: на широком экране игра не растягивается на весь монитор. */
export function ContentColumn(props: { children: ReactNode }): ReactNode {
  return <div className="mx-auto w-full max-w-[480px]">{props.children}</div>;
}

export function SectionTitle(props: { children: ReactNode }): ReactNode {
  return (
    <h2 className="mt-6 mb-2 font-display text-xs font-semibold tracking-widest text-text-muted uppercase">
      {props.children}
    </h2>
  );
}

/**
 * Появление экрана при смене. Ключ — идентификатор экрана: React монтирует
 * новый узел, и анимация проигрывается один раз, без таймеров и состояния.
 */
export function ScreenTransition(props: { screenKey: string; children: ReactNode }): ReactNode {
  return (
    <div key={props.screenKey} className="h-full animate-screen-in">
      {props.children}
    </div>
  );
}
