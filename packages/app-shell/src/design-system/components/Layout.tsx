import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { t } from "../../i18n";
import { uiFeedback } from "../../state/ui-feedback";
import { IconButton } from "./Button";
import { tabLabelMode, type TabLabelMode } from "./tab-labels";

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
      {/* Под шапкой разделов — отступ её высоты: содержимое начинается под ней,
          а при прокрутке уходит под стекло. Внутри раздела отступ нулевой. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-[var(--app-header-h)] pb-4">
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
        <IconButton label={t("app.back")} feedback="back" onClick={props.onBack}>
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
  /**
   * Число или короткая метка — только с полезной нагрузкой: сколько наград
   * забрать, сколько новых предметов (`35-stage4-plan.md`, Р50). Точки
   * «загляни сюда» нет сознательно.
   */
  badge?: string;
}

export interface TabBarProps {
  items: readonly TabItem[];
  activeId: string | null;
  onSelect(id: string): void;
}

/**
 * Нижняя панель разделов.
 *
 * Разделов шесть. Подписи видны у всех, если каждая помещается в свою
 * вкладку (измеряется, `tab-labels.ts`): на телефонах от 360 px так и есть.
 * Иначе подпись только у активного раздела, а сам он поднимается над панелью
 * объёмной плиткой — где ты сейчас, видно издалека. Правило по измерению, а не
 * по порогу ширины: шрифт и язык сменятся, и порог в пикселях соврал бы.
 * Подписи рендерятся всегда, неактивные в режиме «только активная»
 * прозрачны: их можно измерить в любом режиме, а высота панели не меняется.
 *
 * Анимируются только transform и opacity (§3.3): плитка растёт и поднимается,
 * подпись проявляется.
 */
export function TabBar(props: TabBarProps): ReactNode {
  const [labelMode, setLabelMode] = useState<TabLabelMode>("active");
  const row = useRef<HTMLDivElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const labels = useRef<(HTMLSpanElement | null)[]>([]);

  // До отрисовки: на широком экране подписи не мигают.
  useLayoutEffect(() => {
    const count = props.items.length;
    const measure = (): void => {
      const labelWidths = labels.current.slice(0, count).map((label) => label?.scrollWidth ?? 0);
      const tabWidths = tabs.current.slice(0, count).map((tab) => tab?.clientWidth ?? 0);
      setLabelMode(tabLabelMode(labelWidths, tabWidths));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // Подпись меняет ширину, когда догрузился веб-шрифт или сменился текст.
    const observer = new ResizeObserver(measure);
    if (row.current !== null) observer.observe(row.current);
    for (const label of labels.current.slice(0, count)) if (label !== null) observer.observe(label);
    return () => observer.disconnect();
  }, [props.items]);

  return (
    <nav className="shrink-0 border-t border-border bg-surface pb-[var(--app-inset-bottom)]">
      <div ref={row} className="mx-auto flex w-full max-w-[640px]">
        {props.items.map((item, index) => {
          const active = item.id === props.activeId;
          return (
            <button
              key={item.id}
              ref={(node) => {
                tabs.current[index] = node;
              }}
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
                ref={(node) => {
                  labels.current[index] = node;
                }}
                aria-hidden="true"
                className={[
                  "font-text text-xs font-medium whitespace-nowrap",
                  "transition-[opacity,transform] duration-(--duration-base) ease-out",
                  active
                    ? "-translate-y-2 text-accent opacity-100"
                    : labelMode === "all"
                      ? "text-text-muted opacity-100"
                      : "text-text-muted opacity-0",
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
  return (
    <span className="absolute -top-1 -right-1 min-w-5 rounded-pill bg-danger px-1 text-center font-display text-xs font-bold text-text">
      {props.badge}
    </span>
  );
}

export interface SegmentedItem {
  id: string;
  label: string;
  /** сколько ждёт в этом виде — например, наград к забору; ноль и пусто — без знака */
  badge?: number;
}

/** Сколько сегментов помещается строкой; больше — сетка в два столбца. */
const SEGMENTS_IN_ROW = 3;

/**
 * Переключатель видов внутри раздела: «ежедневные / недельные / достижения».
 * Выбранный сегмент поднимается объёмной плашкой — как кнопка, а не просто
 * цветом текста (§4.4).
 *
 * Подписи не обрезаются: обрезанное «Партнё…» не говорит, что внутри.
 * До трёх сегментов — одной строкой, сегмент не уже своего текста, а
 * свободное место делится поровну; не поместились (экран уже 360) — строка
 * прокручивается вбок, и выбранный всегда в кадре. Четыре и больше — сеткой
 * в два столбца: четыре русские подписи со знаками в 328 px не помещаются
 * ни при каком читаемом шрифте, а лента на два экрана прячет половину видов.
 */
export function SegmentedControl(props: {
  items: readonly SegmentedItem[];
  activeId: string;
  label: string;
  onSelect(id: string): void;
}): ReactNode {
  const list = useRef<HTMLDivElement>(null);
  // Только вбок и только внутри ленты: `scrollIntoView` двигал бы и страницу.
  useEffect(() => {
    const element = list.current;
    const active = element?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (element === null || element === undefined || active === null || active === undefined) return;
    const right = active.offsetLeft + active.offsetWidth;
    if (active.offsetLeft < element.scrollLeft) element.scrollLeft = active.offsetLeft;
    else if (right > element.scrollLeft + element.clientWidth) element.scrollLeft = right - element.clientWidth;
  }, [props.activeId]);

  return (
    <div
      ref={list}
      role="tablist"
      aria-label={props.label}
      className={[
        "surface-sunken relative gap-1 rounded-lg p-1",
        props.items.length > SEGMENTS_IN_ROW ? "grid grid-cols-2" : "flex overflow-x-auto [scrollbar-width:none]",
      ].join(" ")}
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
              "relative inline-flex min-h-11 flex-1 shrink-0 items-center justify-center rounded-md px-2 font-display text-sm font-semibold whitespace-nowrap",
              "transition-transform duration-(--duration-fast) ease-base active:scale-[0.97]",
              active ? "btn-secondary" : "text-text-muted",
            ].join(" ")}
          >
            {item.label}
            {item.badge === undefined || item.badge <= 0 ? null : (
              <span className="ml-1.5 inline-block min-w-5 rounded-pill bg-danger px-1 text-center text-xs font-bold text-text">{item.badge}</span>
            )}
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
