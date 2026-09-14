import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { t } from "../../i18n";
import { uiFeedback } from "../../state/ui-feedback";
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

/**
 * Нижняя панель разделов.
 *
 * Разделов шесть, и шесть подписей на экране телефона не помещаются, не
 * превращаясь в мелкий шум. Поэтому подпись есть только у активного раздела, а
 * сам он поднимается над панелью объёмной плиткой — где ты сейчас, видно
 * издалека. Когда ширины хватает всем (планшет, десктоп, ландшафт), подписи
 * показываются у всех: прятать их там незачем. Порог — по ширине самой панели
 * (container query), а не экрана: панель живёт в колонке.
 *
 * Анимируются только transform и opacity (§3.3): плитка растёт и поднимается,
 * подпись проявляется.
 */
export function TabBar(props: TabBarProps): ReactNode {
  return (
    <nav className="@container shrink-0 border-t border-border bg-surface pb-[var(--app-inset-bottom)]">
      <div className="mx-auto flex w-full max-w-[640px]">
        {props.items.map((item) => {
          const active = item.id === props.activeId;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={active ? "page" : undefined}
              aria-label={item.label}
              onClick={() => {
                if (!active) uiFeedback("select");
                props.onSelect(item.id);
              }}
              className="group relative flex min-h-16 flex-1 flex-col items-center justify-center gap-0.5 pt-1"
            >
              <span
                className={[
                  "relative inline-flex size-11 items-center justify-center rounded-lg",
                  "transition-transform duration-(--duration-base) ease-spring",
                  active ? "-translate-y-3 scale-110" : "group-active:scale-90",
                ].join(" ")}
              >
                {/* Плитка активного раздела проявляется под значком: сама
                    подложка не анимирует ни фон, ни тень. */}
                <span
                  aria-hidden="true"
                  className={[
                    "btn-primary absolute inset-0 rounded-lg",
                    "transition-[opacity,transform] duration-(--duration-base) ease-spring",
                    active ? "scale-100 opacity-100" : "scale-75 opacity-0",
                  ].join(" ")}
                />
                <span
                  className={[
                    "relative transition-colors duration-(--duration-fast) ease-base",
                    active ? "text-on-accent" : "text-text-muted group-active:text-text",
                  ].join(" ")}
                >
                  {item.icon}
                </span>
                {item.badge === undefined ? null : <TabBadge badge={item.badge} />}
              </span>
              <span
                aria-hidden="true"
                className={[
                  "font-display text-xs whitespace-nowrap",
                  "transition-[opacity,transform] duration-(--duration-base) ease-out",
                  active
                    ? "-translate-y-2 font-bold text-accent opacity-100"
                    : "hidden text-text-muted @min-[560px]:block",
                ].join(" ")}
              >
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
      <span aria-hidden="true" className="absolute top-1 right-1 inline-flex size-2.5">
        <span className="absolute inset-0 animate-ping-dot rounded-full bg-accent" />
        <span className="relative size-full rounded-full border-2 border-surface bg-accent" />
      </span>
    );
  }

  return (
    <span className="absolute -top-1 -right-1 min-w-5 rounded-pill bg-danger px-1 text-center font-display text-xs font-bold text-text">
      {props.badge}
    </span>
  );
}

export interface SegmentedItem {
  id: string;
  label: string;
}

/**
 * Переключатель видов внутри раздела: «ежедневные / недельные / достижения».
 * Выбранный сегмент поднимается объёмной плашкой — как кнопка, а не просто
 * цветом текста (§4.4).
 */
export function SegmentedControl(props: {
  items: readonly SegmentedItem[];
  activeId: string;
  label: string;
  onSelect(id: string): void;
}): ReactNode {
  return (
    <div
      role="tablist"
      aria-label={props.label}
      className="surface-sunken grid auto-cols-fr grid-flow-col gap-1 rounded-lg p-1"
    >
      {props.items.map((item) => {
        const active = item.id === props.activeId;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => {
              if (active) return;
              uiFeedback("select");
              props.onSelect(item.id);
            }}
            className={[
              "min-h-11 truncate rounded-md px-2 font-display text-sm font-semibold",
              "transition-transform duration-(--duration-fast) ease-base active:scale-[0.97]",
              active ? "btn-secondary" : "text-text-muted",
            ].join(" ")}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/** Колонка контента: на широком экране игра не растягивается на весь монитор. */
export function ContentColumn(props: { children: ReactNode }): ReactNode {
  return <div className="mx-auto w-full max-w-[480px]">{props.children}</div>;
}

/**
 * Заголовок раздела нижней панели. Верхней панели у раздела нет — над ним
 * шапка приложения, — и заголовок живёт в контенте, а не отнимает строку.
 */
export function PageTitle(props: { children: ReactNode }): ReactNode {
  return <h1 className="mt-2 mb-1 font-display text-2xl font-bold text-text">{props.children}</h1>;
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
