import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChevronRight, Gift, Trophy, Users } from "lucide-react";
import { staggerStyle } from "../design-system/components";
import { CoinIcon } from "../design-system/components/CurrencyIcons";
import { ShardIcon } from "../design-system/components/ShardIcon";
import { formatDuration, formatNumber, t } from "../i18n";
import "../i18n/home";
import { useBadges } from "../state/badges";
import { refreshHome, useHome, type HomeWidgets as WidgetData } from "../state/home-api";
import { useMeta } from "../state/meta";
import { useNavigation } from "../state/navigation";
import { track, useShell } from "../state/shell";
import {
  arrangeWidgets,
  dailyFace,
  friendsFace,
  recordFace,
  tasksFace,
  wheelFace,
  type Amount,
  type DailyFace,
  type DayMark,
  type FriendsFace,
  type RecordFace,
  type TasksFace,
  type WheelFace,
  type WidgetId,
  type WidgetSize,
} from "./home-widget-rules";
import { formatCountdown, msUntilReset, useClock } from "./meta/schedule";

/**
 * Виджеты главной (docs/35-stage4-plan.md WP42, часть 3, Р76): награда дня,
 * колесо, задания, рекорд и друзья — у каждого свой тон, свой облик и свой
 * крючок: завтрашняя награда, джекпот колеса, сколько наград ждёт. Порядок и
 * размер — правилом (`home-widget-rules.ts`): готовое к забору — первым и во
 * всю ширину. Подробности — из ответа главной, общего с каруселью; что
 * готово — по знакам меню.
 *
 * Высоты постоянные (токены `--widget-*-h`): ответ сервера меняет текст в
 * плитке, а не её размер, и главная не прыгает.
 *
 * Движение — только `transform` и `opacity`: покачивается колесо, светится
 * сундук. Вне экрана и в свёрнутом приложении оно стоит (`data-still`),
 * с «меньше движения» — тоже (общее правило `tokens.css`).
 */

/** Отсчёты на виджетах — без секунд: часы тикают раз в полминуты. */
const CLOCK_STEP_MS = 30_000;
/** Знаки меню не пришли — раскладка без них, а не заглушка навсегда. */
const BADGES_WAIT_MS = 1_500;
/** После полуночи по Москве награда дня и колесо обновляются — спросить знаки чуть позже границы. */
const MIDNIGHT_SLACK_MS = 5_000;

const TONE: Record<WidgetId, string> = {
  daily: "widget-daily",
  wheel: "widget-wheel",
  tasks: "widget-tasks",
  record: "widget-record",
  friends: "widget-friends",
};

const SIZE: Record<WidgetSize, string> = {
  hero: "col-span-2 h-(--widget-hero-h)",
  tile: "h-(--widget-tile-h)",
  row: "col-span-2 h-(--widget-row-h)",
};

export function HomeWidgets(): ReactNode {
  const withAccount = useShell((state) => state.capabilities.auth !== undefined);
  const playable = useShell((state) => state.adapter.showAd !== undefined);
  const badges = useBadges();
  const data = useHome((state) => state.data);
  const known = useBadgesKnown(withAccount, badges.loadedAt);
  const now = useClock(true, CLOCK_STEP_MS);
  const grid = useRef<HTMLElement>(null);
  const still = useStill(grid, known);

  // Обновились знаки — забег, забор, возврат в приложение — значит, и подробности могли устареть.
  useEffect(() => {
    if (withAccount) void refreshHome();
  }, [withAccount, badges.loadedAt]);
  useMidnightRefresh(withAccount);

  if (!known) return <WidgetsPlaceholder />;

  const widgets: WidgetData = data?.widgets ?? { daily: null, wheel: null, tasks: null };
  const slots = arrangeWidgets({ daily: badges.daily > 0, wheel: badges.wheel > 0, tasks: badges.tasks > 0 });

  return (
    <section ref={grid} aria-label={t("home.widgets")} data-still={still ? "" : undefined} className="mb-3 grid grid-cols-2 gap-3">
      {slots.map((slot, index) => (
        <Widget key={slot.id} id={slot.id} size={slot.size} index={index} widgets={widgets} now={now} playable={playable} />
      ))}
    </section>
  );
}

/**
 * Заглушка той же высоты, что сетка без готового к забору: рекорд во всю
 * ширину и две пары плиток. Та же разметка стоит в `home.tsx`, пока едет чанк.
 */
export function WidgetsPlaceholder(): ReactNode {
  return (
    <div aria-hidden="true" className="mb-3 grid grid-cols-2 gap-3">
      <div className="surface-sunken col-span-2 h-(--widget-hero-h) rounded-lg" />
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="surface-sunken h-(--widget-tile-h) rounded-lg" />
      ))}
    </div>
  );
}

/**
 * Раскладка ждёт знаков меню: иначе виджеты встали бы «ничего не готово», а
 * через полсекунды перестроились. Гостю знаков нет — раскладка сразу; не
 * пришли за полторы секунды — тоже: заглушка навсегда хуже неточного порядка.
 */
function useBadgesKnown(withAccount: boolean, loadedAt: number): boolean {
  const [waited, setWaited] = useState(false);
  const known = !withAccount || loadedAt > 0 || waited;
  useEffect(() => {
    if (known) return;
    const timer = setTimeout(() => setWaited(true), BADGES_WAIT_MS);
    return () => clearTimeout(timer);
  }, [known]);
  return known;
}

/** В полночь по Москве награда дня и бесплатная крутка возвращаются — главная, открытая через полночь, это покажет. */
function useMidnightRefresh(withAccount: boolean): void {
  useEffect(() => {
    if (!withAccount) return;
    const timer = setTimeout(() => {
      // Не вышло — главная останется вчерашней до следующего возврата в приложение, там знаки спросятся снова.
      import("../state/badges-api")
        .then(async ({ loadBadges }) => await loadBadges())
        .catch((error: unknown) => console.warn("Знаки меню после полуночи не загрузились:", error));
    }, msUntilReset(Date.now(), "daily") + MIDNIGHT_SLACK_MS);
    return () => clearTimeout(timer);
  }, [withAccount]);
}

/** Сетка вне экрана или приложение свёрнуто — движение стоит. `shown` — сетка на месте, а не заглушка. */
function useStill(target: RefObject<HTMLElement | null>, shown: boolean): boolean {
  const [offscreen, setOffscreen] = useState(false);
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.visibilityState !== "visible");
  useEffect(() => {
    const onVisibility = (): void => setHidden(document.visibilityState !== "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  useEffect(() => {
    const element = target.current;
    if (element === null || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver((entries) => setOffscreen(entries.every((entry) => !entry.isIntersecting)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [target, shown]);
  return offscreen || hidden;
}

function Widget(props: { id: WidgetId; size: WidgetSize; index: number; widgets: WidgetData; now: number; playable: boolean }): ReactNode {
  const { id, size, index, widgets, now } = props;
  const navigation = useNavigation();
  const badges = useBadges();
  const meta = useMeta();
  // Касание — в аналитику с видом, состоянием и местом: видно, какой крючок срабатывает и где.
  const open = (state: string, go: () => void) => (): void => {
    track("home_widget_clicked", { widget: id, state, position: index });
    go();
  };

  switch (id) {
    case "daily": {
      const face = dailyFace(widgets.daily, badges.daily > 0, now);
      return (
        <Frame id={id} size={size} index={index} ready={face.state === "ready"} onOpen={open(face.state, () => navigation.push("daily"))}>
          <DailyView face={face} size={size} now={now} />
        </Frame>
      );
    }
    case "wheel": {
      const face = wheelFace(widgets.wheel, badges.wheel > 0, now, props.playable);
      return (
        <Frame id={id} size={size} index={index} ready={face.state === "ready"} onOpen={open(face.state, () => navigation.push("wheel"))}>
          <WheelView face={face} size={size} now={now} />
        </Frame>
      );
    }
    case "tasks": {
      const face = tasksFace(widgets.tasks, badges.tasks);
      return (
        <Frame id={id} size={size} index={index} ready={face.state === "ready"} onOpen={open(face.state, () => navigation.resetTo("tasks"))}>
          <TasksView face={face} size={size} />
        </Frame>
      );
    }
    case "record": {
      const face = recordFace(meta.best[meta.lastDifficultyId], meta.lastDifficultyId, meta.lastRun, meta.runs);
      return (
        <Frame id={id} size={size} index={index} ready={false} onOpen={open(face.state, () => navigation.resetTo("rating"))}>
          <RecordView face={face} size={size} difficulty={t(`difficulty.${meta.lastDifficultyId}.name`)} />
        </Frame>
      );
    }
    case "friends": {
      const face = friendsFace(badges.friends);
      return (
        <Frame id={id} size={size} index={index} ready={false} onOpen={open(face.state, () => navigation.resetTo("friends"))}>
          <FriendsView face={face} size={size} />
        </Frame>
      );
    }
  }
}

/**
 * Рамка виджета: тон, подложка по готовности, размер — из токенов; касание —
 * по всей плитке. Без `onOpen` — витрина: та же рамка, но никуда не ведёт.
 */
export function Frame(props: { id: WidgetId; size: WidgetSize; index: number; ready: boolean; onOpen?: () => void; children: ReactNode }): ReactNode {
  const className = [
    TONE[props.id],
    SIZE[props.size],
    props.ready ? "widget-surface-ready" : "widget-surface",
    "relative flex min-w-0 animate-rise-in items-center gap-3 overflow-hidden rounded-lg p-3 text-left",
    "transition-transform duration-(--duration-fast) ease-base",
  ].join(" ");
  if (props.onOpen === undefined) {
    return (
      <div className={className} style={staggerStyle(props.index)}>
        {props.children}
      </div>
    );
  }
  return (
    <button type="button" onClick={props.onOpen} style={staggerStyle(props.index)} className={`${className} active:scale-[0.98]`}>
      {props.children}
    </button>
  );
}

/**
 * Раскладка содержимого. Широкий — облик слева и три строки: подпись,
 * крупное с кнопкой справа, если готово к забору, и мелкое; кнопка стоит
 * только в строке крупного, чтобы подпись и полоса недели шли во всю ширину
 * и на 320 px. Плитка — подпись и облик сверху, крупное и мелкое под ними
 * во всю ширину: в полряда рядом с обликом текст не помещается. Строка —
 * облик, подпись над крупным и стрелка.
 */
function Layout(props: { size: WidgetSize; face: ReactNode; label: string; big: ReactNode; sub?: ReactNode; action?: string; quiet?: boolean }): ReactNode {
  if (props.size === "tile") {
    return (
      <span className="flex h-full min-w-0 flex-1 flex-col justify-between">
        <span className="flex h-7 items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs font-semibold text-text-muted">{props.label}</span>
          <span className="shrink-0">{props.face}</span>
        </span>
        <span className="min-w-0">
          {/* Тихая строка — подсказка без данных: мельче и в две строки, а не обрезанная крупная. */}
          {props.quiet === true ? (
            <span className="line-clamp-2 text-sm leading-snug text-text-muted">{props.big}</span>
          ) : (
            <span className="block truncate font-display text-base leading-tight font-bold text-text">{props.big}</span>
          )}
          {props.sub === undefined ? null : <span className="mt-0.5 block truncate text-xs text-text-muted">{props.sub}</span>}
        </span>
      </span>
    );
  }
  if (props.size === "row") {
    return (
      <>
        <span className="shrink-0">{props.face}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-text-muted">{props.label}</span>
          <span className="block truncate font-display text-sm leading-tight font-bold text-text">{props.big}</span>
        </span>
        <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-text-muted" />
      </>
    );
  }
  return (
    <>
      <span className="shrink-0">{props.face}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-text-muted">{props.label}</span>
        <span className="mt-0.5 flex min-h-7 items-center justify-between gap-2">
          {/* На 320 px рядом с кнопкой крупная строка на ступень меньше — иначе «Крутка ждёт» обрезалась бы. */}
          <span className="min-w-0 truncate font-display text-base leading-tight font-bold text-text min-[360px]:text-lg">{props.big}</span>
          {props.action === undefined ? (
            <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-text-muted" />
          ) : (
            <span className="shrink-0 rounded-pill bg-(--widget-tone) px-3 py-1 font-display text-xs font-bold text-on-accent">{props.action}</span>
          )}
        </span>
        {props.sub === undefined ? null : <span className="mt-1 block min-w-0 truncate text-xs text-text-muted">{props.sub}</span>}
      </span>
    </>
  );
}

/** Облик-значок: квадрат тона с иконкой; у широкого — крупнее. */
function IconFace(props: { size: WidgetSize; children: ReactNode; glow?: boolean }): ReactNode {
  const box = props.size === "hero" ? "size-12" : props.size === "row" ? "size-10" : "size-7";
  return (
    <span className={`widget-face relative inline-flex ${box} items-center justify-center rounded-md`}>
      {props.glow === true ? <span aria-hidden="true" className="widget-motion absolute -inset-2 animate-glow rounded-full bg-[radial-gradient(closest-side,var(--widget-daily-glow),transparent)] opacity-60" /> : null}
      <span className="relative">{props.children}</span>
    </span>
  );
}

function iconSize(size: WidgetSize): number {
  return size === "hero" ? 26 : size === "row" ? 22 : 16;
}

/** Облик-рисунок — колесо, кольцо — того же размера, что облик-значок. */
function faceSize(size: WidgetSize): number {
  return size === "hero" ? 48 : size === "row" ? 40 : 28;
}

/**
 * Подпись: в плитке — короткая, в полряда 320 px длинная обрезалась бы;
 * облик и крупная строка и так говорят, что это за виджет.
 */
function label(id: WidgetId, size: WidgetSize): string {
  return t(size === "tile" ? `widget.${id}.short` : `widget.${id}.title`);
}

/**
 * «через 5 ч 50 мин», «через 12 мин» — то же правило точности, что у всех
 * отсчётов (`formatCountdown`): вниз не округляем, иначе игрок вернётся раньше
 * срока и увидит, что ещё рано.
 */
function inTime(ms: number): string {
  return t("widget.in", { time: formatCountdown(ms) });
}

/** Монеты (и осколки, если есть) — значком и числом; словами — для экранного диктора. */
function Reward(props: { amount: Amount; size?: number }): ReactNode {
  const size = props.size ?? 16;
  return (
    <span className="inline-flex items-center gap-1 align-middle tabular-nums">
      <CoinIcon size={size} />
      <span>{formatNumber(props.amount.coins)}</span>
      {props.amount.shards > 0 ? (
        <>
          <ShardIcon rarity="common" size={size} />
          <span>{formatNumber(props.amount.shards)}</span>
        </>
      ) : null}
      <span className="sr-only">{t("home.slide.coins", { n: props.amount.coins })}</span>
    </span>
  );
}

export function DailyView(props: { face: DailyFace; size: WidgetSize; now: number }): ReactNode {
  const { face, size } = props;
  // Подарок и в ожидании: чанк этого значка главная и так грузит со слайдами, а свой значок ожидания стал бы ещё одним файлом.
  const icon = (
    <IconFace size={size} glow={face.state === "ready"}>
      <Gift size={iconSize(size)} />
    </IconFace>
  );
  switch (face.state) {
    case "ready":
      return (
        <Layout
          size={size}
          face={icon}
          label={face.day === null || size === "tile" ? label("daily", size) : t("widget.daily.titleDay", { day: face.day })}
          big={face.reward === null ? t("widget.daily.ready") : <Reward amount={face.reward} size={18} />}
          sub={face.days.length === 0 ? undefined : <WeekStrip days={face.days} />}
          action={t("widget.claim")}
        />
      );
    case "waiting":
      return (
        <Layout
          size={size}
          face={icon}
          label={label("daily", size)}
          big={face.next === null ? t("widget.daily.tomorrow") : <Reward amount={face.next} />}
          sub={t("widget.daily.tomorrowIn", { time: inTime(face.untilMs - props.now) })}
        />
      );
    case "idle":
      return <Layout size={size} face={icon} label={label("daily", size)} big={t("widget.daily.idle")} quiet />;
  }
}

/**
 * Неделя награды дня полосой: забранное — тоном, сегодняшнее — светится,
 * впереди — тёмным; седьмой день крупнее и с наградой — виден заранее.
 */
function WeekStrip(props: { days: readonly DayMark[] }): ReactNode {
  const seventh = props.days.at(-1);
  return (
    <span className="flex items-center gap-2">
      <span className="flex min-w-0 flex-1 items-center gap-1" aria-hidden="true">
        {props.days.map((day, index) => (
          <span
            key={index}
            className={[
              "h-1.5 rounded-pill",
              index === props.days.length - 1 ? "flex-[1.6]" : "flex-1",
              day.claimed ? "bg-(--widget-tone)" : day.today ? "bg-(--widget-daily-glow)" : "bg-surface-sunken",
            ].join(" ")}
          />
        ))}
      </span>
      {seventh === undefined ? null : (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-text-muted">
          <span className="sr-only">{t("widget.daily.seventh")}</span>
          <Reward amount={seventh} size={12} />
        </span>
      )}
    </span>
  );
}

export function WheelView(props: { face: WheelFace; size: WidgetSize; now: number }): ReactNode {
  const { face, size } = props;
  const spinning = face.state === "ready";
  const wheel = <MiniWheel size={faceSize(size)} rocking={spinning} />;
  const jackpot = (amount: number | null): ReactNode =>
    amount === null ? undefined : (
      <span className="inline-flex items-center gap-1">
        {t("widget.wheel.upTo")} <Reward amount={{ coins: amount, shards: 0 }} size={14} />
      </span>
    );
  switch (face.state) {
    case "ready":
      return <Layout size={size} face={wheel} label={label("wheel", size)} big={t("widget.wheel.free")} sub={jackpot(face.jackpot)} action={t("widget.wheel.spin")} />;
    case "ad":
      return <Layout size={size} face={wheel} label={label("wheel", size)} big={t("widget.wheel.ad")} sub={face.vip ? t("widget.wheel.vipHint") : t("widget.wheel.adHint")} />;
    case "cooldown":
      return <Layout size={size} face={wheel} label={label("wheel", size)} big={t("widget.wheel.ad")} sub={inTime(face.untilMs - props.now)} />;
    case "waiting":
      // Ждать до новых суток — крючком остаётся джекпот, отсчёт — мелко.
      return <Layout size={size} face={wheel} label={label("wheel", size)} big={jackpot(face.jackpot) ?? t("widget.wheel.free")} sub={inTime(face.untilMs - props.now)} />;
    case "idle":
      return <Layout size={size} face={wheel} label={label("wheel", size)} big={t("widget.wheel.idle")} quiet />;
  }
}

/** Восемь секторов мини-колеса — как у настоящего, считаются один раз. */
const WHEEL_SECTOR_PATHS = Array.from({ length: 8 }, (_, index) => {
  const point = (share: number): string => `${(20 + 18 * Math.sin(share * Math.PI * 2)).toFixed(2)} ${(20 - 18 * Math.cos(share * Math.PI * 2)).toFixed(2)}`;
  return `M20 20 L${point(index / 8)} A18 18 0 0 1 ${point((index + 1) / 8)} Z`;
});

/** Мини-колесо: сектора через один и ступица; ждёт крутка — покачивается. */
function MiniWheel(props: { size: number; rocking: boolean }): ReactNode {
  const paths = WHEEL_SECTOR_PATHS.map((path, index) => <path key={index} d={path} fill={index % 2 === 0 ? "var(--widget-wheel-sector)" : "var(--widget-wheel-sector-alt)"} />);
  return (
    <span className="relative inline-flex" style={{ width: props.size, height: props.size }}>
      <svg viewBox="0 0 40 40" width={props.size} height={props.size} aria-hidden="true" className={props.rocking ? "widget-motion animate-widget-rock" : undefined}>
        <circle cx="20" cy="20" r="19.5" fill="var(--widget-wheel-sector-alt)" stroke="var(--widget-tone)" strokeWidth="1" />
        {paths}
        <circle cx="20" cy="20" r="4" fill="var(--widget-tone)" />
      </svg>
      {/* Стрелка неподвижна, качается колесо под ней. */}
      <svg viewBox="0 0 40 40" width={props.size} height={props.size} aria-hidden="true" className="absolute inset-0">
        <path d="M16.5 0 H23.5 L20 7 Z" fill="var(--color-text)" />
      </svg>
    </span>
  );
}

export function TasksView(props: { face: TasksFace; size: WidgetSize }): ReactNode {
  const { face, size } = props;
  const done = face.state === "idle" ? 0 : face.done;
  const total = face.state === "idle" ? null : face.total;
  const ring = <Ring size={faceSize(size)} done={done ?? 0} total={total} />;
  switch (face.state) {
    case "ready":
      return (
        <Layout
          size={size}
          face={ring}
          label={label("tasks", size)}
          big={t("widget.tasks.ready", { n: face.claimable })}
          sub={face.done === null || face.total === null ? undefined : `${t("widget.tasks.progress", { done: face.done, total: face.total })} ${t("widget.tasks.progressHint")}`}
          action={t("widget.claim")}
        />
      );
    case "progress":
      return <Layout size={size} face={ring} label={label("tasks", size)} big={t("widget.tasks.progress", { done: face.done, total: face.total })} sub={t("widget.tasks.progressHint")} />;
    case "idle":
      return <Layout size={size} face={ring} label={label("tasks", size)} big={t("widget.tasks.idle")} quiet />;
  }
}

/** Кольцо прогресса суток: дорожка видна и пустой; в широком — «2/4» внутри. */
function Ring(props: { size: number; done: number; total: number | null }): ReactNode {
  const radius = 16;
  const length = 2 * Math.PI * radius;
  const share = props.total === null || props.total === 0 ? 0 : Math.min(1, props.done / props.total);
  return (
    <span className="relative inline-flex items-center justify-center" style={{ width: props.size, height: props.size }}>
      <svg viewBox="0 0 40 40" width={props.size} height={props.size} aria-hidden="true" className="-rotate-90">
        <circle cx="20" cy="20" r={radius} fill="none" stroke="var(--widget-tasks-track)" strokeWidth="5" />
        {/* Пустое кольцо — только дорожка: скруглённый конец нулевой дуги рисовал бы точку. */}
        {share === 0 ? null : <circle cx="20" cy="20" r={radius} fill="none" stroke="var(--widget-tone)" strokeWidth="5" strokeLinecap="round" strokeDasharray={`${(share * length).toFixed(2)} ${length.toFixed(2)}`} />}
      </svg>
      {props.total === null || props.size < 40 ? null : (
        <span aria-hidden="true" className="absolute font-display text-[11px] font-bold text-text tabular-nums">
          {props.done}/{props.total}
        </span>
      )}
    </span>
  );
}

export function RecordView(props: { face: RecordFace; size: WidgetSize; difficulty: string }): ReactNode {
  const { face, size } = props;
  const icon = (
    <IconFace size={size}>
      <Trophy size={iconSize(size)} />
    </IconFace>
  );
  // Рекорд — на выбранной сложности: широкий называет её, плитке хватает «Рекорд».
  const title = size === "tile" ? label("record", size) : t("widget.record.on", { difficulty: props.difficulty });
  switch (face.state) {
    case "none":
      return <Layout size={size} face={icon} label={title} big="—" sub={size === "tile" ? t("widget.record.noneShort") : t("widget.record.none")} />;
    case "record":
      return <Layout size={size} face={icon} label={title} big={<Time sec={face.bestSec} size={size} />} sub={t("widget.record.fresh")} />;
    case "gap":
      return <Layout size={size} face={icon} label={title} big={<Time sec={face.bestSec} size={size} />} sub={t("widget.record.gap", { time: formatDuration(face.gapSec) })} />;
    case "best":
      return <Layout size={size} face={icon} label={title} big={<Time sec={face.bestSec} size={size} />} sub={t("lobby.runs", { count: face.runs })} />;
  }
}

function Time(props: { sec: number; size: WidgetSize }): ReactNode {
  return <span className={`tabular-nums ${props.size === "hero" ? "text-xl" : ""}`}>{formatDuration(props.sec)}</span>;
}

export function FriendsView(props: { face: FriendsFace; size: WidgetSize }): ReactNode {
  const { face, size } = props;
  const icon = (
    <IconFace size={size}>
      <Users size={iconSize(size)} />
    </IconFace>
  );
  return face.state === "news" ? (
    <Layout size={size} face={icon} label={label("friends", size)} big={t("widget.friends.news", { n: face.count })} sub={t("widget.friends.newsHint")} />
  ) : (
    <Layout size={size} face={icon} label={label("friends", size)} big={t("widget.friends.idle")} quiet />
  );
}
