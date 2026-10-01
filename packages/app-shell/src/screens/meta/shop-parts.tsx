import type { ReactNode } from "react";
import { Check, Crown, ExternalLink, Sparkles, TrendingUp } from "lucide-react";
import { Badge, Button, Card } from "../../design-system/components";
import { CoinIcon, GemIcon } from "../../design-system/components/CurrencyIcons";
import { ShardIcon, shardRarity } from "../../design-system/components/ShardIcon";
import { StarsIcon } from "../../design-system/components/StarsIcon";
import { formatDecimal, formatNumber, hasTranslation, t } from "../../i18n";
import type { ShopItem, VipView } from "../../state/shop-api";
import { formatCountdown, msUntilReset } from "./schedule";
import { badgeLabel, itemName, resourceLabel } from "./shop-texts";

/**
 * Карточки магазина (docs/35-stage4-plan.md §3.6): VIP, набор, плитка
 * самоцветов, плашка Tribute. Подача — только правда: бейдж и выгоду считает
 * сервер, состав виден целиком до оплаты (Р11).
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

function StarsButton(props: { stars: number; label: string; busy: boolean; disabled: boolean; glow?: boolean; onClick: () => void }): ReactNode {
  return (
    <Button block variant="stars" glow={props.glow} disabled={props.disabled} loading={props.busy} ariaLabel={props.label} onClick={props.onClick}>
      <StarsIcon size={18} />
      <span className="tabular-nums">{formatNumber(props.stars)}</span>
    </Button>
  );
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
    <Card selected={vip.active} stripe="accent" appearIndex={0}>
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
          <Button
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
          <Button
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
          <Button variant="ghost" disabled={busy !== null} loading={busy === "vip:cancel"} onClick={props.onCancel}>
            {t("vip.cancel")}
          </Button>
        ) : null}
        {vip.canResume ? (
          <Button variant="secondary" disabled={busy !== null} loading={busy === "vip:resume"} onClick={props.onResume}>
            {t("vip.resume")}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

/** Набор с составом: стартовый, набор кузнеца, подобранный игроку. */
export function ItemCard(props: { item: ShopItem; index: number; busy: string | null; forYou?: boolean; onBuy: () => void }): ReactNode {
  const { item } = props;
  const name = itemName(item);
  const textKey = `shop.sku.${item.sku}.text`;
  const stars = item.stars;
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
          <StarsButton stars={stars} label={t("shop.buy", { name, stars, n: stars })} busy={props.busy === item.sku} disabled={props.busy !== null} glow={props.forYou} onClick={props.onBuy} />
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
export function GemPackTile(props: { item: ShopItem; index: number; busy: string | null; onBuy: () => void }): ReactNode {
  const { item } = props;
  const gems = item.contents.find((part) => part.resource === "gems")?.amount ?? 0;
  const badge = badgeLabel(item.badge);
  const stars = item.stars;
  const name = itemName(item);
  return (
    <Card appearIndex={props.index} compact stripe={item.badge === "best" ? "accent" : undefined}>
      {badge === null ? null : (
        <span className="absolute top-2 left-2">
          <Badge tone={item.badge === "best" ? "accent" : "warning"}>{badge}</Badge>
        </span>
      )}
      <div className="mt-5 flex flex-col items-center gap-1 text-center">
        <GemIcon size={44} />
        <p className="font-display text-2xl font-bold tabular-nums text-text">{formatNumber(gems)}</p>
        <p className="text-xs text-text-muted">{t("shop.gems.word", { n: gems })}</p>
        {item.valuePct === undefined || item.valuePct === null ? (
          <span className="h-5" />
        ) : (
          <span className="rounded-pill bg-success/15 px-2 font-display text-xs font-bold text-success">{t("shop.value", { pct: item.valuePct })}</span>
        )}
      </div>
      {stars === null ? null : (
        <div className="mt-2">
          <StarsButton stars={stars} label={t("shop.buy", { name, stars, n: stars })} busy={props.busy === item.sku} disabled={props.busy !== null} onClick={props.onBuy} />
        </div>
      )}
    </Card>
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
        <Button block variant="secondary" onClick={props.onOpen}>
          <ExternalLink size={18} aria-hidden="true" />
          {t("shop.tribute.cta")}
        </Button>
      </div>
    </Card>
  );
}
