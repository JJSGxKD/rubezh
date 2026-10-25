import type { ReactNode } from "react";
import { Check, Crown, ExternalLink, Sparkles, TrendingUp } from "lucide-react";
import { Badge, Button, Card, staggerStyle } from "../../design-system/components";
import { CoinIcon, GemIcon } from "../../design-system/components/CurrencyIcons";
import { ShardIcon, shardRarity } from "../../design-system/components/ShardIcon";
import { StarsIcon } from "../../design-system/components/StarsIcon";
import { formatDecimal, formatNumber, hasTranslation, t } from "../../i18n";
import type { ShopItem, VipView } from "../../state/shop-api";
import { formatCountdown, msUntilReset } from "./schedule";
import { gemPileSize, gemsOf } from "./shop-look";
import { badgeLabel, buyLabel, itemName, promoLeft, resourceLabel, shownPrice, type ShopPromo } from "./shop-texts";

/**
 * Карточки магазина (docs/35-stage4-plan.md §3.6): VIP, набор, плитка
 * самоцветов, плашка Tribute. Подача — только правда: бейдж и выгоду считает
 * сервер, состав виден целиком до оплаты (Р11), а зачёркнутая цена бывает
 * только у акции — это цена каталога, по которой товар продаётся вне её.
 */

const DATE = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });

export function dateOf(iso: string | null): string {
  return iso === null ? "—" : DATE.format(new Date(iso));
}

export function statusLine(vip: VipView): string | null {
  if (vip.until === null) return null;
  const date = dateOf(vip.until);
  if (!vip.active) return t("vip.ended", { date });
  if (vip.renewal === "on") return t("vip.until.on", { date });
  return t(vip.renewal === "failed" ? "vip.until.failed" : "vip.until.cancelled", { date });
}

/**
 * Вид ресурса различается и цветом, и формой значка — одним цветом он не
 * передаётся (docs/27-design-system-and-app-shell.md §4.4). Осколки — общим
 * значком цвета своей редкости, как в арсенале и на колесе.
 */
export function ResourceIcon(props: { resource: string; size?: number }): ReactNode {
  const size = props.size ?? 16;
  if (props.resource === "coins") return <CoinIcon size={size} />;
  if (props.resource === "gems") return <GemIcon size={size} />;
  return <ShardIcon rarity={shardRarity(props.resource) ?? ""} size={size} />;
}

/** Цена кнопкой; по акции — с зачёркнутой ценой каталога перед ней. */
export function StarsButton(props: { stars: number; full?: number | null; label: string; busy: boolean; disabled: boolean; glow?: boolean; cut?: boolean; block?: boolean; onClick: () => void }): ReactNode {
  return (
    <Button track="buy_stars" block={props.block ?? true} variant="stars" glow={props.glow} cut={props.cut} disabled={props.disabled} loading={props.busy} ariaLabel={props.label} onClick={props.onClick}>
      <StarsIcon size={18} />
      {props.full === undefined || props.full === null ? null : <s className="tabular-nums opacity-70">{formatNumber(props.full)}</s>}
      <span className="tabular-nums">{formatNumber(props.stars)}</span>
    </Button>
  );
}

/** Ярлык скидки — цветом опасности: он о том, что скоро кончится. */
export function PromoBadge(props: { promo: ShopPromo }): ReactNode {
  return <Badge tone="danger">{t("shop.promo.badge", { pct: props.promo.percent })}</Badge>;
}

export function VipCard(props: {
  vip: VipView;
  busy: string | null;
  onOrder: (vip: VipView) => void;
  onCancel: () => void;
  onResume: () => void;
  onClaim: () => void;
}): ReactNode {
  const { vip, busy } = props;
  const stars = vip.stars;
  return (
    // Своя разметка вместо `Card`: у него нет подложки тона. VIP — в тоне элиты
    // (design/screens/shop.html), у действующего ещё и свечение.
    <div
      className={[
        "relative flex w-full animate-rise-in flex-col overflow-hidden rounded-lg border border-elite/45 bg-linear-to-br from-elite/12 via-surface-raised to-surface p-4 text-left",
        vip.active ? "shadow-[0_0_28px_-10px] shadow-elite/70 ring-1 ring-elite/50" : "",
      ].join(" ")}
      style={staggerStyle(0)}
    >
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-accent" />
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="inline-flex size-12 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-elite/40 to-accent/30 text-elite">
          <Crown size={26} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-lg font-bold text-text">{t("vip.title")}</p>
          <p className="text-sm text-text-muted">{statusLine(vip) ?? t("vip.pitch", { days: vip.periodDays })}</p>
        </div>
      </div>

      <ul className="mt-3 grid gap-1.5 text-sm text-text">
        <li className="flex items-center gap-2">
          <Sparkles size={16} aria-hidden="true" className="text-accent" />
          {t("vip.perk.noAds")}
        </li>
        {vip.rewardMul !== undefined && vip.rewardMul > 1 ? (
          <li className="flex items-center gap-2">
            <TrendingUp size={16} aria-hidden="true" className="text-accent" />
            {t("vip.perk.rewards", { mul: formatDecimal(vip.rewardMul) })}
          </li>
        ) : null}
        <li className="flex items-center gap-2">
          <GemIcon size={16} />
          {t("vip.perk.daily", { gems: formatNumber(vip.daily.gems), n: vip.daily.gems })}
        </li>
      </ul>

      <div className="mt-4 grid gap-2">
        {vip.active ? (
          <Button track="claim_vip_daily"
            block
            variant={vip.daily.claimed ? "secondary" : "primary"}
            disabled={vip.daily.claimed || busy !== null}
            loading={busy === "vip:daily"}
            onClick={props.onClaim}
          >
            {vip.daily.claimed
              ? t("vip.daily.next", { time: formatCountdown(msUntilReset(Date.now(), "daily")) })
              : t("vip.daily.claim", { gems: formatNumber(vip.daily.gems), n: vip.daily.gems })}
          </Button>
        ) : null}

        {/* Отменённое нами продление возвращается бесплатно — вторая подписка тут лишняя. */}
        {vip.canOrder && !vip.canResume && stars !== null ? (
          <Button track="buy_vip"
            block
            variant="stars"
            glow={!vip.active}
            disabled={busy !== null}
            loading={busy === "vip"}
            ariaLabel={t(vip.active ? "vip.renew" : "vip.order", { stars, n: stars })}
            onClick={() => props.onOrder(vip)}
          >
            <StarsIcon size={18} />
            <span className="tabular-nums">{t("vip.price", { stars, days: vip.periodDays })}</span>
          </Button>
        ) : null}

        {vip.active && vip.renewal === "on" ? (
          <Button track="cancel_vip" variant="ghost" disabled={busy !== null} loading={busy === "vip:cancel"} onClick={props.onCancel}>
            {t("vip.cancel")}
          </Button>
        ) : null}
        {vip.canResume ? (
          <Button track="resume_vip" variant="secondary" disabled={busy !== null} loading={busy === "vip:resume"} onClick={props.onResume}>
            {t("vip.resume")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Набор с составом: стартовый, набор кузнеца, подобранный игроку. */
export function ItemCard(props: { item: ShopItem; index: number; busy: string | null; now: number; forYou?: boolean; onBuy: () => void }): ReactNode {
  const { item } = props;
  const name = itemName(item);
  const textKey = `shop.sku.${item.sku}.text`;
  const price = shownPrice(item, props.now);
  const stars = price.stars;
  const badge = badgeLabel(item.badge);
  return (
    <Card appearIndex={props.index} stripe={item.kind === "starter" || props.forYou === true ? "accent" : undefined} disabled={item.owned}>
      {props.forYou === true ? <p className="mb-1 font-display text-xs font-semibold tracking-widest text-accent uppercase">{t("shop.forYou")}</p> : null}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-base font-bold text-text">{name}</p>
          {hasTranslation(textKey) ? <p className="text-xs text-text-muted">{t(textKey)}</p> : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {price.promo === null || item.owned ? null : <PromoBadge promo={price.promo} />}
          {item.once && !item.owned ? <Badge tone="accent">{t("shop.once")}</Badge> : null}
          {badge === null ? null : <Badge tone="warning">{badge}</Badge>}
        </div>
      </div>

      {/* Состав — целиком и до оплаты: случайного за деньги в игре нет (Р11). */}
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm text-text">
        {item.contents.map((part) => (
          <li key={part.resource} className="flex items-center gap-1.5">
            <ResourceIcon resource={part.resource} />
            {resourceLabel(part.resource, part.amount)}
          </li>
        ))}
      </ul>

      {item.owned ? (
        <p className="mt-3 flex items-center gap-1.5 text-sm font-semibold text-success">
          <Check size={16} aria-hidden="true" />
          {t("shop.owned")}
        </p>
      ) : stars === null ? null : (
        <div className="mt-3">
          {price.promo === null ? null : <p className="mb-1.5 text-xs font-semibold text-danger">{t("shop.promo.left", { time: promoLeft(price.promo, props.now) })}</p>}
          <StarsButton stars={stars} full={price.full} label={buyLabel(item, price)} busy={props.busy === item.sku} disabled={props.busy !== null} glow={props.forYou} cut={props.forYou} onClick={props.onBuy} />
        </div>
      )}
    </Card>
  );
}

/**
 * Набор самоцветов плиткой: крупно — сколько, бейдж — «Хит» или «Лучшая
 * цена», выгода — на сколько больше самоцветов за звезду, чем в самом
 * дорогом за самоцвет наборе.
 * Всё это сервер считает, а не придумывает экран.
 */
export function GemPackTile(props: { item: ShopItem; index: number; busy: string | null; now: number; packs: readonly number[]; onBuy: () => void }): ReactNode {
  const { item } = props;
  const gems = gemsOf(item);
  const badge = badgeLabel(item.badge);
  const price = shownPrice(item, props.now);
  const stars = price.stars;
  const best = item.badge === "best";
  return (
    // «Лучшая цена» выделена рамкой и свечением акцента, а не полосой слева.
    // Рамка и появление — на оболочке: у `Card` нет своего класса, а карточка
    // не должна въезжать в уже стоящую на месте рамку.
    <div
      className={["flex animate-rise-in rounded-lg", best ? "shadow-[0_0_22px_-10px] shadow-accent ring-1 ring-accent/55" : ""].join(" ")}
      style={staggerStyle(props.index)}
    >
    <Card compact>
      {badge === null ? null : (
        <span className="absolute top-2 left-2">
          <Badge tone={item.badge === "best" ? "accent" : "warning"}>{badge}</Badge>
        </span>
      )}
      {price.promo === null ? null : (
        <span className="absolute top-2 right-2">
          <PromoBadge promo={price.promo} />
        </span>
      )}
      <div className="mt-5 flex flex-col items-center gap-1 text-center">
        <GemPile size={gemPileSize(gems, props.packs)} />
        <p className="font-display text-[26px] font-bold tabular-nums text-text">{formatNumber(gems)}</p>
        <p className="text-xs text-text-muted">{t("shop.gems.word", { n: gems })}</p>
        {/* Одна строка под числом у всех плиток — кнопки стоят вровень. Идущая акция важнее выгоды: она кончится. */}
        {price.promo !== null ? (
          <span className="h-5 font-display text-xs font-bold whitespace-nowrap text-danger">{t("shop.promo.leftShort", { time: promoLeft(price.promo, props.now) })}</span>
        ) : item.valuePct === undefined || item.valuePct === null ? (
          <span className="h-5" />
        ) : (
          <span className="rounded-pill bg-success/15 px-2 font-display text-xs font-bold text-success">{t("shop.value", { pct: item.valuePct })}</span>
        )}
      </div>
      {stars === null ? null : (
        <div className="mt-2">
          <StarsButton stars={stars} full={price.full} label={buyLabel(item, price)} busy={props.busy === item.sku} disabled={props.busy !== null} onClick={props.onBuy} />
        </div>
      )}
    </Card>
    </div>
  );
}

/** Высоты значков в горсти, от края к краю: середина крупнее (design/screens/shop.html). */
const PILE_HEIGHTS: Record<1 | 3 | 5, readonly number[]> = { 1: [26], 3: [22, 30, 22], 5: [20, 26, 34, 26, 20] };

/** Горсть самоцветов по размеру набора: значки внахлёст на 2 px, ряд прижат к низу. */
function GemPile(props: { size: 1 | 3 | 5 }): ReactNode {
  return (
    <div aria-hidden="true" className="flex h-14 items-end justify-center">
      {PILE_HEIGHTS[props.size].map((height, index) => (
        <span key={index} className={index === 0 ? "" : "-ml-0.5"}>
          <GemIcon size={height} />
        </span>
      ))}
    </div>
  );
}

/** Звёзды дешевле через Tribute — ссылка из настроек сервера; открывается площадкой в том же нажатии. */
export function TributePlaque(props: { onOpen: () => void }): ReactNode {
  return (
    <Card stripe="accent" appearIndex={0}>
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-elite/40 to-warning/25">
          <StarsIcon size={24} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-base font-bold text-text">{t("shop.tribute.title")}</p>
          <p className="text-xs text-text-muted">{t("shop.tribute.text")}</p>
        </div>
      </div>
      <div className="mt-3">
        <Button track="tribute" block variant="secondary" onClick={props.onOpen}>
          <ExternalLink size={18} aria-hidden="true" />
          {t("shop.tribute.cta")}
        </Button>
      </div>
    </Card>
  );
}
