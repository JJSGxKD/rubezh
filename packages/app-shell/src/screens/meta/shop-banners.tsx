import { useState, type ReactNode, type UIEvent } from "react";
import { Crown, Rocket, Shield, Sparkles } from "lucide-react";
import { Button } from "../../design-system/components";
import { StarsIcon } from "../../design-system/components/StarsIcon";
import { formatNumber, t } from "../../i18n";
import { ResourceIcon } from "./shop-parts";
import { itemName, resourceLabel, type ShopBanner } from "./shop-texts";

/**
 * Полоса баннеров наверху магазина: листается пальцем, по одному баннеру на
 * экран и краем следующего — видно, что дальше есть ещё. Сама не листается:
 * баннер, уезжающий из-под пальца, мешает читать, а движение без касания
 * надоедает к третьему визиту (docs/27-design-system-and-app-shell.md §7.1).
 *
 * Тон баннера — цвет того, что он продаёт: VIP — золото элиты, снаряжение —
 * цвет пассивок, звёзды — фирменный цвет Stars. Все цвета — токены палитры.
 */

const TONE: Record<ShopBanner["kind"], { surface: string; icon: string }> = {
  vip: { surface: "from-elite/35 via-accent/10 to-surface border-elite/50", icon: "text-elite" },
  starter: { surface: "from-success/30 via-surface-raised to-surface border-success/40", icon: "text-success" },
  recommended: { surface: "from-accent/30 via-surface-raised to-surface border-accent/50", icon: "text-accent" },
  gear: { surface: "from-passive/30 via-surface-raised to-surface border-passive/40", icon: "text-passive" },
  tribute: { surface: "from-stars/25 via-surface-raised to-surface border-stars/40", icon: "text-stars" },
};

function BannerArt(props: { kind: ShopBanner["kind"] }): ReactNode {
  const size = 88;
  switch (props.kind) {
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
  return t(`shop.banner.${banner.kind}.title`);
}

/** Набор в баннере — составом, как в карточке: что именно за звёзды, видно сразу (Р11). */
function BannerText(props: { banner: ShopBanner }): ReactNode {
  const { banner } = props;
  if (banner.kind === "starter" || banner.kind === "recommended") {
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

function BannerAction(props: { banner: ShopBanner; busy: string | null; onAction: () => void }): ReactNode {
  const { banner, busy } = props;
  if (banner.kind === "starter" || banner.kind === "recommended") {
    const stars = banner.item.stars ?? 0;
    const name = itemName(banner.item);
    return (
      <Button
        variant="stars"
        glow
        disabled={busy !== null}
        loading={busy === banner.item.sku}
        ariaLabel={t("shop.buy", { name, stars, n: stars })}
        onClick={props.onAction}
      >
        <StarsIcon size={18} />
        <span className="tabular-nums">{formatNumber(stars)}</span>
      </Button>
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

export function ShopBanners(props: {
  banners: readonly ShopBanner[];
  busy: string | null;
  onAction: (banner: ShopBanner, position: number) => void;
}): ReactNode {
  const [current, setCurrent] = useState(0);
  const total = props.banners.length;
  if (total === 0) return null;

  /** Какой баннер в кадре — по шагу между первыми двумя: ширину и зазор задаёт вёрстка, а не число здесь. */
  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    const strip = event.currentTarget;
    const first = strip.children.item(0);
    const second = strip.children.item(1);
    if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement)) return;
    const step = second.offsetLeft - first.offsetLeft;
    if (step <= 0) return;
    const next = Math.min(total - 1, Math.max(0, Math.round(strip.scrollLeft / step)));
    if (next !== current) setCurrent(next);
  };

  return (
    <section aria-roledescription={t("shop.banner.carousel")} aria-label={t("shop.banner.label")}>
      <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 pb-1 [scrollbar-width:none]" onScroll={onScroll}>
        {props.banners.map((banner, index) => {
          const tone = TONE[banner.kind];
          return (
            <article
              key={banner.kind}
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
              <p className={`font-display text-xs font-semibold tracking-widest uppercase ${tone.icon}`}>{t(`shop.banner.${banner.kind}.eyebrow`)}</p>
              <h2 className="mt-1 font-display text-xl leading-tight font-bold text-text">{bannerTitle(banner)}</h2>
              <div className="mt-1 flex-1 pr-14">
                <BannerText banner={banner} />
              </div>
              <div className="mt-3 self-start">
                <BannerAction banner={banner} busy={props.busy} onAction={() => props.onAction(banner, index)} />
              </div>
            </article>
          );
        })}
      </div>
      {total === 1 ? null : (
        <div aria-hidden="true" className="mt-2 flex justify-center gap-1.5">
          {props.banners.map((banner, index) => (
            <span
              key={banner.kind}
              className={`size-1.5 rounded-pill transition-transform duration-(--duration-fast) ease-base ${index === current ? "scale-150 bg-accent" : "bg-border-strong"}`}
            />
          ))}
        </div>
      )}
    </section>
  );
}
