import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Info, Lock, X } from "lucide-react";
import { t } from "../../i18n";
import { useBackLayer } from "../../state/back-stack";
import { useWide } from "../../state/wide";
import { uiFeedback } from "../../state/ui-feedback";
import { Button, IconButton } from "./Button";
import { CutFrame } from "./CutFrame";
import { useDialogFocus } from "./dialog-focus";
import { Badge } from "./Data";
import { useModalHost } from "./modal-host";
import { modalFooterPlacement, modalMount } from "./modal-rules";
import { RelicFrame } from "./RelicFrame";
import { modalPlacementOn } from "./wide-rules";

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
  /**
   * Срезанный угол с рамкой по срезу вместо скругления (design/README.md): им
   * отмечено главное на экране, поэтому свойство включают точечно. Внешней
   * тени у среза нет — её обрезает `clip-path`.
   */
  cut?: boolean;
}

export function Card(props: CardProps): ReactNode {
  const interactive = props.onClick !== undefined;
  const selected = props.selected === true;
  const cut = props.cut === true;
  const padding = props.compact === true ? "p-3" : "p-4";
  const className = [
    // flex-col: кнопка по умолчанию центрирует содержимое по вертикали, и в
    // ряду карточек разной длины текст «плавал» бы на разной высоте.
    // У среза обрезку и скругление делает сам `CutFrame`, поля — его слой.
    cut ? "relative flex w-full flex-col text-left" : "relative flex w-full flex-col overflow-hidden rounded-lg text-left",
    cut ? "" : padding,
    "transition-transform duration-(--duration-fast) ease-base",
    cut ? "" : selected ? "surface-card-selected" : "surface-card",
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

  // Срез оборачивает содержимое, а не сам элемент: кнопка остаётся кнопкой.
  const content = cut ? (
    <CutFrame tone={selected ? "card-selected" : "card"} size="md" className={`flex w-full flex-col text-left ${padding}`}>
      {body}
    </CutFrame>
  ) : (
    body
  );

  if (!interactive) {
    return (
      <div className={className} style={style}>
        {content}
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
      {content}
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
  /** id заголовка в содержимом — имя диалога для диктора, когда своего `title` нет */
  labelledBy?: string;
  /** значок над заголовком — у модалок забега он заменяет иллюстрацию */
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * Подвал не прокручивается с телом, а закреплён под ним: на длинном листе
   * прокручивается только середина, шапка и подвал на месте. Без `footer` не
   * действует. Выключено по умолчанию — модалки забега тесные (§5.3).
   */
  pinFooter?: boolean;
  /**
   * Снизу — лист подтверждения, по центру — модалка забега. Лист снизу на
   * wide (с 1024 px) открывается панелью справа: `modalPlacementOn`.
   */
  placement?: "center" | "bottom";
  /** широкая — для трёх карточек в ряд в ландшафте (§5.3) */
  size?: "m" | "l";
  /**
   * Закрыть тапом по затемнению и клавишей Escape. Только у листов и
   * подтверждений: модалки забега так не закрываются — промах пальцем мимо
   * карточки улучшения не должен ничего делать.
   */
  onDismiss?: () => void;
  /** срезанный угол панели (design/README.md): у окон выбора и итога забега */
  cut?: boolean;
  /**
   * Сцена над панелью, а в ландшафте — слева от неё: сундук с лучами и
   * искрами. Панель обрезает содержимое, а сцене нужен простор над
   * затемнением.
   */
  hero?: ReactNode;
  /**
   * Панель-реликвия v2 тоном из токенов (`RelicFrame`) вместо обычной
   * панели — у окон наград.
   */
  relic?: string;
}

export function Modal(props: ModalProps): ReactNode {
  const wideScreen = useWide((state) => state.wide);
  const placement = modalPlacementOn(props.placement, wideScreen);
  const bottom = placement === "bottom";
  const side = placement === "side";
  const wide = props.size === "l";
  const { onDismiss } = props;
  const host = useModalHost();
  const mount = modalMount(host);
  const root = useRef<HTMLDivElement>(null);
  useDialogFocus(root, mount !== "wait");

  // Лист снизу шуршит на открытии и закрытии; модалки забега — уровень,
  // пауза, смерть — звучат своими звуками событий, а не листом.
  const sheet = bottom || side;
  useEffect(() => {
    if (!sheet) return;
    uiFeedback("sheetOpen");
    return () => uiFeedback("sheetClose");
  }, [sheet]);

  // «Назад» площадки и Esc закрывают верхнюю модалку, а не уводят экран из-под
  // неё (WP45): слой стека живёт, пока модалка открыта.
  useBackLayer(onDismiss);

  const closable = onDismiss !== undefined;
  // Заголовок со значком — по центру над содержимым, как у модалок забега:
  // значок у них — сам предмет, и разносить его с названием нельзя. Тогда в
  // шапке только крестик.
  const headerTitle = closable && props.icon === undefined;
  const footerPlacement = modalFooterPlacement({ hasFooter: props.footer !== undefined, pinFooter: props.pinFooter === true });

  const panel = (
    <Panel
      cut={props.cut === true}
      relic={props.relic}
      side={side}
      className={[
        side ? "max-w-(--side-panel-width)" : wide ? "max-w-[420px] landscape:max-w-[760px]" : "max-w-[420px]",
        props.hero === undefined ? "" : "min-h-0",
        side ? "animate-panel-in" : bottom ? "animate-sheet-in" : "animate-pop-in",
      ].join(" ")}
    >
      {/* Закрываемую модалку закрывают там, где палец, — сверху (Р81).
          Шапка не прокручивается: крестик виден и в конце длинного листа. */}
      {closable ? (
        <header className="flex shrink-0 items-start gap-2 py-2 pr-2 pl-5 short:pl-4 landscape:pl-4">
          {headerTitle ? <h2 className="min-w-0 flex-1 pt-2 font-display text-xl font-bold text-text">{props.title}</h2> : <span className="flex-1" />}
          <IconButton track="close" label={t("app.close")} feedback={sheet ? null : "back"} onClick={onDismiss}>
            <X size={22} />
          </IconButton>
        </header>
      ) : null}
      <div
        className={[
          "min-h-0 overflow-y-auto overscroll-contain px-5 short:px-4 landscape:px-4",
          footerPlacement === "pinned" ? "" : "pb-5 short:pb-4 landscape:pb-4",
          closable ? "" : "pt-5 short:pt-4 landscape:pt-4",
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
        {props.title === undefined || headerTitle ? null : (
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
        {footerPlacement === "scroll" ? <div className="mt-5 grid gap-2">{props.footer}</div> : null}
      </div>
      {footerPlacement === "pinned" ? (
        <div className="grid shrink-0 gap-2 px-5 pt-5 pb-5 short:px-4 short:pb-4 landscape:px-4 landscape:pb-4">{props.footer}</div>
      ) : null}
    </Panel>
  );

  const dialog = (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={props.title}
      aria-labelledby={props.labelledBy}
      // Фокус при открытии ставится на само окно (`useDialogFocus`): кольцо
      // вокруг всего экрана ничего не говорит — его нет.
      tabIndex={-1}
      className={[
        "pointer-events-auto absolute inset-0 flex focus-visible:outline-none",
        // Панель сбоку прижата к краю окна: полей вокруг неё нет, только вырез камеры.
        side
          ? "items-stretch justify-end pt-(--app-inset-top) pr-(--app-inset-right) pb-(--app-inset-bottom)"
          : [
              "px-4 pt-[calc(1rem+var(--app-inset-top))] pb-[calc(1rem+var(--app-inset-bottom))]",
              "pr-[calc(1rem+var(--app-inset-right))] pl-[calc(1rem+var(--app-inset-left))]",
              bottom ? "items-end justify-center" : "items-center justify-center",
            ].join(" "),
      ].join(" ")}
      style={{ zIndex: "var(--z-modal)" }}
    >
      <div aria-hidden="true" className="absolute inset-0 animate-fade-in bg-bg/80" onClick={onDismiss} />
      {props.hero === undefined ? (
        panel
      ) : (
        // Сцена и панель — одной колонкой: панель сжимается под прокрутку,
        // а сцена остаётся целой.
        <div className="relative flex max-h-full w-full max-w-[420px] flex-col items-center landscape:max-w-[760px] landscape:flex-row">
          {props.hero}
          {panel}
        </div>
      )}
    </div>
  );

  if (mount === "wait") return null;
  return mount === "portal" && host ? createPortal(dialog, host) : dialog;
}

/** Панель модалки: со срезом — `CutFrame`, без него — прежняя поверхность со скруглением. */
function Panel(props: { cut: boolean; relic?: string | undefined; side?: boolean; className: string; children: ReactNode }): ReactNode {
  if (props.relic !== undefined) {
    return (
      <RelicFrame tone={props.relic} className={props.className}>
        {props.children}
      </RelicFrame>
    );
  }
  if (props.cut) {
    return (
      <CutFrame tone="panel" size="md" className={`flex max-h-full w-full flex-col overflow-hidden ${props.className}`}>
        {props.children}
      </CutFrame>
    );
  }
  // Панель сбоку — во всю высоту окна, скруглена только со стороны содержимого.
  const shape = props.side === true ? "h-full rounded-l-xl" : "rounded-xl";
  return (
    <div className={`surface-panel relative flex max-h-full w-full flex-col overflow-hidden ${shape} ${props.className}`}>
      {props.children}
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

/**
 * Пояснение без пометки «в разработке»: пустой список, нужен вход, версия без
 * связи с сервером. Раздел работает — ему просто нечего показать, и бейдж
 * «в разработке» здесь врал бы.
 */
export function InfoNotice(props: { text: string }): ReactNode {
  return (
    <div className="surface-sunken flex items-start gap-2.5 rounded-lg px-3 py-2.5">
      <Info size={16} aria-hidden="true" className="mt-px shrink-0 text-info" />
      <p className="min-w-0 flex-1 text-xs text-text-muted">{props.text}</p>
    </div>
  );
}

/**
 * Пустой раздел — знаком и словами посередине, а не сноской сверху: пустой
 * экран со сноской у края выглядит недогруженным. Знак — тот же медальон, что
 * над наградой дня и промокодом, только спокойный: пустота — не событие.
 */
export function EmptyState(props: { icon: ReactNode; text: string }): ReactNode {
  return (
    <div className="flex animate-rise-in flex-col items-center gap-3 px-2 py-10 text-center">
      <IconEmblem tone="muted">{props.icon}</IconEmblem>
      <p className="max-w-[300px] text-sm text-text-muted">{props.text}</p>
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
        <Button track="retry" onClick={props.onRetry}>{t("app.retry")}</Button>
      )}
    </div>
  );
}
