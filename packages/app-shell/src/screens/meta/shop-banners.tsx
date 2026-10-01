import { useRef, useState, type MouseEvent, type PointerEvent, type ReactNode, type UIEvent } from "react";
import { BadgePercent, Crown, Rocket, Shield, Sparkles } from "lucide-react";
import { Button } from "../../design-system/components";
import { StarsIcon } from "../../design-system/components/StarsIcon";
import { formatNumber, t } from "../../i18n";
import { ResourceIcon, StarsButton } from "./shop-parts";
import { bannerKey, buyLabel, itemName, promoLeft, resourceLabel, shownPrice, type ShopBanner } from "./shop-texts";

/**
 * Полоса баннеров наверху магазина: листается пальцем, по одному баннеру на
 * экран и краем следующего — видно, что дальше есть ещё. Сама не листается:
 * баннер, уезжающий из-под пальца, мешает читать, а движение без касания
 * надоедает к третьему визиту (docs/27-design-system-and-app-shell.md §7.1).
 *
 * Тон баннера — цвет того, что он продаёт: VIP — золото элиты, снаряжение —
 * цвет пассивок, звёзды — фирменный цвет Stars, акция — цвет опасности: она
 * кончается. Все цвета — токены палитры.
 */

const TONE: Record<ShopBanner["kind"], { surface: string; icon: string }> = {
  promo: { surface: "from-danger/30 via-surface-raised to-surface border-danger/40", icon: "text-danger" },
  vip: { surface: "from-elite/35 via-accent/10 to-surface border-elite/50", icon: "text-elite" },
  starter: { surface: "from-success/30 via-surface-raised to-surface border-success/40", icon: "text-success" },
  recommended: { surface: "from-accent/30 via-surface-raised to-surface border-accent/50", icon: "text-accent" },
  gear: { surface: "from-passive/30 via-surface-raised to-surface border-passive/40", icon: "text-passive" },
  tribute: { surface: "from-stars/25 via-surface-raised to-surface border-stars/40", icon: "text-stars" },
};

function BannerArt(props: { kind: ShopBanner["kind"] }): ReactNode {
  const size = 88;
  switch (props.kind) {
    case "promo":
      return <BadgePercent size={size} strokeWidth={1.5} />;
    case "vip":
      return <Crown size={size} strokeWidth={1.5} />;
    case "starter":
      return <Rocket size={size} strokeWidth={1.5} />;
    case "recommended":
      return <Sparkles size={size} strokeWidth={1.5} />;
    case "gear":
      return <Shield size={size} strokeWidth={1.5} />;
    case "tribute":
      return <StarsIcon size={size} />;
  }
}

function bannerTitle(banner: ShopBanner): string {
  if (banner.kind === "recommended") return itemName(banner.item);
  if (banner.kind === "promo") return banner.item.promo?.title ?? itemName(banner.item);
  return t(`shop.banner.${banner.kind}.title`);
}

/**
 * Над заголовком — что это; у акции — скидка и сколько ей осталось: заголовок
 * может быть подписью команды, и скидка не должна от неё зависеть.
 */
function bannerEyebrow(banner: ShopBanner, now: number): string {
  if (banner.kind !== "promo") return t(`shop.banner.${banner.kind}.eyebrow`);
  const promo = shownPrice(banner.item, now).promo;
  return promo === null ? t("shop.banner.promo.over") : t("shop.banner.promo.eyebrow", { pct: promo.percent, time: promoLeft(promo, now) });
}

/** Набор в баннере — составом, как в карточке: что именно за звёзды, видно сразу (Р11). */
function BannerText(props: { banner: ShopBanner }): ReactNode {
  const { banner } = props;
  if ("item" in banner) {
    return (
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-text">
        {banner.item.contents.map((part) => (
          <li key={part.resource} className="flex items-center gap-1.5">
            <ResourceIcon resource={part.resource} />
            {resourceLabel(part.resource, part.amount)}
          </li>
        ))}
      </ul>
    );
  }
  return <p className="text-sm text-text-muted">{t(`shop.banner.${banner.kind}.text`)}</p>;
}

function BannerAction(props: { banner: ShopBanner; busy: string | null; now: number; onAction: () => void }): ReactNode {
  const { banner, busy } = props;
  if ("item" in banner) {
    const price = shownPrice(banner.item, props.now);
    return (
      <StarsButton
        block={false}
        glow
        stars={price.stars ?? 0}
        full={price.full}
        label={buyLabel(banner.item, price)}
        busy={busy === banner.item.sku}
        disabled={busy !== null}
        onClick={props.onAction}
      />
    );
  }
  if (banner.kind === "vip") {
    return (
      <Button
        variant="stars"
        glow
        disabled={busy !== null}
        loading={busy === "vip"}
        ariaLabel={t("vip.order", { stars: banner.stars, n: banner.stars })}
        onClick={props.onAction}
      >
        <StarsIcon size={18} />
        <span className="tabular-nums">{formatNumber(banner.stars)}</span>
      </Button>
    );
  }
  return (
    <Button variant="secondary" onClick={props.onAction}>
      {t(`shop.banner.${banner.kind}.cta`)}
    </Button>
  );
}

/** Сдвиг мыши, после которого нажатие считается перетаскиванием, а не кликом, px. */
const DRAG_THRESHOLD = 6;

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function ShopBanners(props: {
  banners: readonly ShopBanner[];
  busy: string | null;
  now: number;
  onAction: (banner: ShopBanner, position: number) => void;
}): ReactNode {
  const [current, setCurrent] = useState(0);
  const [dragging, setDragging] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; scroll: number; moved: boolean } | null>(null);
  // Клик приходит после отпускания, когда состояние уже сброшено, — помним жест отдельно.
  const justDragged = useRef(false);
  const total = props.banners.length;
  if (total === 0) return null;

  /** Шаг между баннерами — по вёрстке, а не числом здесь: ширину и зазор задают классы. */
  const stepOf = (element: HTMLDivElement): number => {
    const first = element.children.item(0);
    const second = element.children.item(1);
    if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement)) return 0;
    return second.offsetLeft - first.offsetLeft;
  };

  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    const step = stepOf(event.currentTarget);
    if (step <= 0) return;
    const next = Math.min(total - 1, Math.max(0, Math.round(event.currentTarget.scrollLeft / step)));
    if (next !== current) setCurrent(next);
  };

  const scrollToIndex = (index: number): void => {
    const element = strip.current;
    if (element === null) return;
    element.scrollTo({ left: index * stepOf(element), behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };

  /**
   * Мышью ленту тянут так же, как пальцем: на ПК и в Telegram Desktop
   * горизонтальной прокрутки колесом у многих нет. Палец и перо прокручивают
   * ленту сами — их не трогаем. Пока тянут, привязка к баннеру выключена,
   * иначе лента дёргается под курсором; отпустили — доезжает до ближайшего.
   */
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    justDragged.current = false;
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    drag.current = { x: event.clientX, scroll: event.currentTarget.scrollLeft, moved: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    if (state === null) return;
    const dx = event.clientX - state.x;
    if (!state.moved && Math.abs(dx) < DRAG_THRESHOLD) return;
    if (!state.moved) {
      state.moved = true;
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.currentTarget.scrollLeft = state.scroll - dx;
  };
  const endDrag = (): void => {
    const state = drag.current;
    drag.current = null;
    if (state === null || !state.moved) return;
    justDragged.current = true;
    setDragging(false);
    const element = strip.current;
    const step = element === null ? 0 : stepOf(element);
    if (element !== null && step > 0) scrollToIndex(Math.min(total - 1, Math.max(0, Math.round(element.scrollLeft / step))));
  };
  /** Отпущенная после перетаскивания кнопка не должна покупать: это был жест, а не нажатие. */
  const onClickCapture = (event: MouseEvent<HTMLDivElement>): void => {
    if (!justDragged.current) return;
    justDragged.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <section className="min-w-0" aria-roledescription={t("shop.banner.carousel")} aria-label={t("shop.banner.label")}>
      <div
        ref={strip}
        className={[
          "-mx-4 flex gap-3 overflow-x-auto scroll-px-4 px-4 pb-1 [scrollbar-width:none]",
          dragging ? "cursor-grabbing select-none" : "cursor-grab snap-x snap-mandatory",
        ].join(" ")}
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClickCapture={onClickCapture}
      >
        {props.banners.map((banner, index) => {
          const tone = TONE[banner.kind];
          return (
            <article
              key={bannerKey(banner)}
              role="group"
              aria-roledescription={t("shop.banner.slide")}
              aria-label={t("shop.banner.position", { n: index + 1, total })}
              className={[
                "relative flex min-h-40 shrink-0 snap-start flex-col overflow-hidden rounded-xl border p-4",
                "bg-linear-to-br shadow-card",
                total === 1 ? "w-full" : "w-[86%]",
                tone.surface,
              ].join(" ")}
            >
              <span aria-hidden="true" className={`pointer-events-none absolute -right-3 -bottom-3 opacity-25 ${tone.icon}`}>
                <BannerArt kind={banner.kind} />
              </span>
              <p className={`font-display text-xs font-semibold tracking-widest uppercase ${tone.icon}`}>{bannerEyebrow(banner, props.now)}</p>
              <h2 className="mt-1 font-display text-xl leading-tight font-bold text-text">{bannerTitle(banner)}</h2>
              <div className="mt-1 flex-1 pr-14">
                <BannerText banner={banner} />
              </div>
              <div className="mt-3 self-start">
                <BannerAction banner={banner} busy={props.busy} now={props.now} onAction={() => props.onAction(banner, index)} />
              </div>
            </article>
          );
        })}
      </div>
      {/* Точки — кнопки: на ПК листать ленту пальцем нечем. Цель нажатия — 24 px
          при точке в 6: попасть в точку пальцем иначе нельзя. */}
      {total === 1 ? null : (
        <div className="mt-1 flex justify-center">
          {props.banners.map((banner, index) => (
            <button
              key={bannerKey(banner)}
              type="button"
              aria-label={t("shop.banner.position", { n: index + 1, total })}
              aria-current={index === current}
              onClick={() => scrollToIndex(index)}
              className="inline-flex size-6 items-center justify-center"
            >
              <span
                aria-hidden="true"
                className={`size-1.5 rounded-pill transition-transform duration-(--duration-fast) ease-base ${index === current ? "scale-150 bg-accent" : "bg-border-strong"}`}
              />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
