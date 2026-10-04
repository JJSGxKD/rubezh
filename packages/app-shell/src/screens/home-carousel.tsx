import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSwipeStrip } from "../design-system/components/swipe-strip";
import { t } from "../i18n";
import "../i18n/home";
import { cachedSlides, loadSlides, safeLink, slideImageUrl, type HomeSlide } from "../state/home-api";
import { openExternalLink } from "../state/external-link";
import { TAB_ROOTS, useNavigation } from "../state/navigation";
import { track, useShell } from "../state/shell";
import { SlideDots, SlideView, STRIP_CLASS } from "./home-slide";
import { useClock } from "./meta/schedule";

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
      track("home_slide_viewed", slideEvent(slide, current));
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
        className={`${STRIP_CLASS} ${dragClass}`}
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
        <SlideDots
          ids={slides.map((slide) => slide.id)}
          current={current}
          onSelect={(index) => {
            touch();
            scrollToIndex(index);
          }}
        />
      )}
    </section>
  );
}

/** Вид и место слайда; у слайда команды — ещё какой анонс. */
function slideEvent(slide: HomeSlide, position: number): { slide: string; position: number; slideId?: string } {
  return slide.kind === "team" ? { slide: slide.kind, position, slideId: slide.slideId } : { slide: slide.kind, position };
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

function SlideCard(props: { slide: HomeSlide; index: number; total: number; now: number }): ReactNode {
  const { slide } = props;
  const navigation = useNavigation();
  const baseUrl = useShell((state) => state.capabilities.auth?.baseUrl);

  // Ссылку открывают в том же нажатии: площадка открывает ссылки только в ответ на касание.
  const open = (): void => {
    track("home_slide_clicked", slideEvent(slide, props.index));
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
      case "team": {
        const { target } = slide;
        if (target.kind === "screen") {
          // Раздел нижней панели — сменой вкладки, остальное — поверх главной: «Назад» вернёт сюда.
          return (TAB_ROOTS as readonly string[]).includes(target.screen) ? navigation.resetTo(target.screen) : navigation.push(target.screen);
        }
        const link = safeLink(target.url);
        if (link !== null) openExternalLink(link);
        return;
      }
    }
  };

  const image = slide.kind === "task" || slide.kind === "team" ? slideImageUrl(slide.image, baseUrl) : null;
  return <SlideView slide={slide} now={props.now} image={image} wide={props.total === 1} onOpen={open} />;
}
