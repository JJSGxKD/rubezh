import { useEffect, useRef, useState, type ReactNode } from "react";
import { BadgePercent, Crown, Megaphone, Newspaper, Rocket, Target, UserPlus } from "lucide-react";
// Компонент из общего входа дизайн-системы держит ядро значков в общем чанке
// первой загрузки: без него сборщик выносит ядро в отдельный файл
// (docs/27-design-system-and-app-shell.md §3.4).
import { Badge } from "../design-system/components";
import { CoinIcon, GemIcon } from "../design-system/components/CurrencyIcons";
import { useSwipeStrip } from "../design-system/components/swipe-strip";
import { formatNumber, t } from "../i18n";
import "../i18n/home";
import { cachedSlides, loadSlides, safeLink, slideImageUrl, type HomeSlide } from "../state/home-api";
import { openExternalLink } from "../state/external-link";
import { useNavigation } from "../state/navigation";
import { track, useShell } from "../state/shell";
import { formatCountdown, useClock } from "./meta/schedule";

/**
 * Карусель главной (docs/35-stage4-plan.md WP42, Р76): что можно сделать
 * сейчас — акция, новое в версии, VIP, друзья, канал, задание партнёра.
 * Что и в каком порядке — решил сервер; карусель только рисует и ведёт.
 *
 * Не выше 112 px: она стоит над «Играть», а не вместо неё. Край следующего
 * слайда виден — понятно, что дальше есть ещё. Листается сама раз в шесть
 * секунд, пока игрок её не тронул; тронул — до следующего захода не
 * листается, а при «меньше движения» не листается вовсе: движение без
 * касания надоедает к третьему визиту (docs/27-design-system-and-app-shell.md §7.1).
 *
 * Приходит своим чанком после первого кадра; место держит заглушка той же
 * высоты — главная не прыгает.
 */

const AUTO_MS = 6_000;
/** Сколько слайд должен быть на виду, чтобы засчитать показ. */
const VIEWED_MS = 1_000;
const CLOCK_STEP_MS = 30_000;
/** Низкий ландшафт телефона: там карусель спрятана (`home.tsx`) — не листается и показов не считает. */
const LOW_SCREEN = "(max-height: 480px)";
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
/**
 * Края ленты гаснут на ширину поля: на широком экране лента кончается не у
 * края экрана, и соседний слайд иначе обрезан ножом посреди фона.
 */
const EDGE_FADE = "[mask-image:linear-gradient(to_right,transparent,#000_16px,#000_calc(100%-16px),transparent)]";

/** Медиазапрос живьём: телефон поворачивают, «меньше движения» включают на ходу. */
function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const list = matchMedia(query);
    const update = (): void => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function HomeCarousel(): ReactNode {
  const [slides, setSlides] = useState<HomeSlide[] | null>(() => cachedSlides());
  const total = slides?.length ?? 0;
  const { strip, current, dragClass, scrollToIndex, handlers } = useSwipeStrip(total);
  const touched = useRef(false);
  const viewed = useRef(new Set<string>());
  const hidden = useMedia(LOW_SCREEN);
  const still = useMedia(REDUCED_MOTION);
  const now = useClock(slides?.some((slide) => slide.kind === "promo") === true, CLOCK_STEP_MS);

  useEffect(() => {
    let alive = true;
    void loadSlides().then((loaded) => {
      if (alive) setSlides(loaded ?? []);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Сама листается, пока не тронули; свёрнутое приложение не листает.
  useEffect(() => {
    if (total < 2 || still || hidden) return;
    const timer = setInterval(() => {
      if (touched.current || document.visibilityState !== "visible") return;
      scrollToIndex((current + 1) % total);
    }, AUTO_MS);
    return () => clearInterval(timer);
  }, [current, total, still, hidden]);

  // Показ — раз за заход и только если слайд пробыл на виду секунду: пролистанный мимо не в счёт.
  useEffect(() => {
    const slide = slides?.[current];
    if (slide === undefined || hidden || viewed.current.has(slide.id)) return;
    const timer = setTimeout(() => {
      if (document.visibilityState !== "visible") return;
      viewed.current.add(slide.id);
      track("home_slide_viewed", { slide: slide.kind, position: current });
    }, VIEWED_MS);
    return () => clearTimeout(timer);
  }, [current, slides, hidden]);

  if (slides === null) return <CarouselPlaceholder />;
  if (total === 0) return null;

  // Тронул — до следующего захода не листается: слайд, уехавший из-под пальца, мешает читать.
  const touch = (): void => {
    touched.current = true;
  };

  return (
    <section className="mb-3 min-w-0" aria-roledescription={t("home.carousel.role")} aria-label={t("home.carousel")}>
      <div
        ref={strip}
        className={`-mx-4 flex gap-2 overflow-x-auto scroll-px-4 px-4 [scrollbar-width:none] ${EDGE_FADE} ${dragClass}`}
        {...handlers}
        onPointerDown={(event) => {
          touch();
          handlers.onPointerDown(event);
        }}
        onWheel={touch}
        onKeyDown={touch}
      >
        {slides.map((slide, index) => (
          <SlideCard key={slide.id} slide={slide} index={index} total={total} now={now} />
        ))}
      </div>
      {total === 1 ? null : (
        // Точки — кнопки: на ПК листать пальцем нечем. Цель нажатия — 24 px при точке в 6.
        <div className="flex justify-center">
          {slides.map((slide, index) => (
            <button
              key={slide.id}
              type="button"
              aria-label={t("home.carousel.position", { n: index + 1, total })}
              aria-current={index === current}
              onClick={() => {
                touch();
                scrollToIndex(index);
              }}
              className="inline-flex size-6 items-center justify-center"
            >
              <span aria-hidden="true" className={`size-1.5 rounded-pill transition-transform duration-(--duration-fast) ease-base ${index === current ? "scale-150 bg-accent" : "bg-border-strong"}`} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Заглушка той же высоты, что карусель с точками: пока ответ в пути, главная
 * не прыгает. Та же разметка стоит в `home.tsx`, пока едет сам чанк.
 */
export function CarouselPlaceholder(): ReactNode {
  return (
    <div aria-hidden="true" className="mb-3">
      <div className="surface-sunken h-20 rounded-lg" />
      <div className="h-6" />
    </div>
  );
}

const TONE: Record<HomeSlide["kind"], string> = {
  promo: "bg-danger/15 text-danger",
  changelog: "bg-info/15 text-info",
  vip: "bg-elite/15 text-elite",
  starter: "bg-success/15 text-success",
  invite: "bg-accent/15 text-accent",
  channel: "bg-info/15 text-info",
  task: "bg-passive/15 text-passive",
};

function SlideIcon(props: { slide: HomeSlide }): ReactNode {
  switch (props.slide.kind) {
    case "promo":
      return <BadgePercent size={30} />;
    case "changelog":
      return <Newspaper size={30} />;
    case "vip":
      return <Crown size={30} />;
    case "starter":
      return <Rocket size={30} />;
    case "invite":
      return <UserPlus size={30} />;
    case "channel":
      return <Megaphone size={30} />;
    case "task":
      return <Target size={30} />;
  }
}

function SlideCard(props: { slide: HomeSlide; index: number; total: number; now: number }): ReactNode {
  const { slide } = props;
  const navigation = useNavigation();
  const baseUrl = useShell((state) => state.capabilities.auth?.baseUrl);
  const [broken, setBroken] = useState(false);
  const image = slide.kind === "task" && !broken ? slideImageUrl(slide.image, baseUrl) : null;

  // Ссылку открывают в том же нажатии: площадка открывает ссылки только в ответ на касание.
  const open = (): void => {
    track("home_slide_clicked", { slide: slide.kind, position: props.index });
    switch (slide.kind) {
      case "promo":
      case "vip":
      case "starter":
        return navigation.resetTo("shop");
      case "changelog":
        return navigation.push("changelog");
      case "invite":
        return navigation.resetTo("friends");
      case "task":
        return navigation.resetTo("tasks");
      case "channel": {
        const link = safeLink(slide.url);
        if (link !== null) openExternalLink(link);
        return;
      }
    }
  };

  return (
    <button
      type="button"
      aria-label={[titleOf(slide), chipLabel(slide, props.now), textOf(slide, props.now)].filter((part) => part !== null).join(". ")}
      onClick={open}
      className={[
        "surface-card flex h-20 shrink-0 snap-start items-center gap-3 rounded-lg px-3 text-left",
        "transition-transform duration-(--duration-fast) ease-base active:scale-[0.98]",
        props.total === 1 ? "w-full" : "w-[88%]",
      ].join(" ")}
    >
      {image === null ? (
        <span className={`inline-flex size-14 shrink-0 items-center justify-center rounded-md ${TONE[slide.kind]}`}>
          <SlideIcon slide={slide} />
        </span>
      ) : (
        <img src={image} alt="" width={56} height={56} decoding="async" onError={() => setBroken(true)} className="size-14 shrink-0 rounded-md bg-surface-sunken object-cover" />
      )}
      <span aria-hidden="true" className="min-w-0 flex-1">
        <span className="block truncate font-display text-sm font-bold text-text">{titleOf(slide)}</span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-text-muted">
          <SlideChip slide={slide} now={props.now} />
          <span className="truncate">{textOf(slide, props.now)}</span>
        </span>
      </span>
    </button>
  );
}

/**
 * Перед подписью — то, ради чего стоит нажать: скидка акции или награда
 * задания. Цены здесь нет: на главной цепляет выгода, цену игрок увидит в
 * магазине.
 */
function SlideChip(props: { slide: HomeSlide; now: number }): ReactNode {
  const { slide } = props;
  if (slide.kind === "promo" && Date.parse(slide.endsAt) > props.now) {
    return (
      <span className="shrink-0 tabular-nums">
        <Badge tone="danger">{t("home.slide.promo.discount", { percent: slide.percent })}</Badge>
      </span>
    );
  }
  if (slide.kind === "task" && taskPrize(slide) !== null) {
    const gems = slide.reward.gems > 0;
    return (
      <span className="inline-flex shrink-0 items-center gap-1 font-display font-bold text-text tabular-nums">
        {gems ? <GemIcon size={14} /> : <CoinIcon size={14} />}+{formatNumber(gems ? slide.reward.gems : slide.reward.coins)}
      </span>
    );
  }
  return null;
}

/** Награда задания, которую стоит показать числом: самоцветы важнее монет; одни осколки — словами. */
function taskPrize(slide: Extract<HomeSlide, { kind: "task" }>): number | null {
  if (slide.reward.gems > 0) return slide.reward.gems;
  return slide.reward.coins > 0 ? slide.reward.coins : null;
}

/** То же, что значок перед подписью, — словами для экранного диктора. */
function chipLabel(slide: HomeSlide, now: number): string | null {
  if (slide.kind === "promo") return Date.parse(slide.endsAt) > now ? t("home.slide.promo.discountLabel", { percent: slide.percent }) : null;
  if (slide.kind !== "task") return null;
  const prize = taskPrize(slide);
  if (prize === null) return null;
  return t(slide.reward.gems > 0 ? "home.slide.gems" : "home.slide.coins", { n: prize });
}

export function titleOf(slide: HomeSlide): string {
  if (slide.kind === "promo") return slide.title ?? t("home.slide.promo.title");
  if (slide.kind === "task") return slide.title ?? t("home.slide.task.title");
  return t(`home.slide.${slide.kind}.title`);
}

/** Подпись слайда; у акции — сколько ей осталось: скидка стоит плашкой перед подписью. */
export function textOf(slide: HomeSlide, now = Date.now()): string {
  switch (slide.kind) {
    case "promo": {
      const left = Date.parse(slide.endsAt) - now;
      return left > 0 ? t("home.slide.promo.text", { time: formatCountdown(left) }) : t("home.slide.promo.over");
    }
    case "changelog":
      return t("home.slide.changelog.text", { versions: slide.versions });
    case "task":
      return t(taskPrize(slide) === null ? "home.slide.task.text" : "home.slide.task.prize");
    default:
      return t(`home.slide.${slide.kind}.text`);
  }
}
