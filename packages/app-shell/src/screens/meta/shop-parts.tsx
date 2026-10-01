import type { ReactNode } from "react";
import { Check, Crown, Sparkles, TrendingUp } from "lucide-react";
import { Badge, Button, Card } from "../../design-system/components";
import { CoinIcon, GemIcon } from "../../design-system/components/CurrencyIcons";
import { ShardIcon, shardRarity } from "../../design-system/components/ShardIcon";
import { StarsIcon } from "../../design-system/components/StarsIcon";
import { formatDecimal, formatNumber, hasTranslation, t } from "../../i18n";
import type { ShopItem, VipView } from "../../state/shop-api";
import { formatCountdown, msUntilReset } from "./schedule";
import { itemName, resourceLabel } from "./shop-texts";

/**
 * Карточки магазина (docs/35-stage4-plan.md §3.6): VIP и набор. Отдельно от
 * экрана — экран собирает из них вкладки, а не держит вёрстку каждой.
 */

const DATE = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });

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
        <span aria-hidden="true" className="inline-flex size-11 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
          <Crown size={24} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-lg font-bold text-text">{t("vip.title")}</p>
          <p className="text-sm text-text-muted">{statusLine(vip) ?? t("vip.pitch", { days: vip.periodDays })}</p>
        </div>
      </div>

      <ul className="mt-3 grid gap-1.5 text-sm text-text">
        <li className="flex items-center gap-2">
          <GemIcon size={16} />
          {t("vip.perk.daily", { gems: formatNumber(vip.daily.gems), n: vip.daily.gems })}
        </li>
        {vip.rewardMul !== undefined && vip.rewardMul > 1 ? (
          <li className="flex items-center gap-2">
            <TrendingUp size={16} aria-hidden="true" className="text-accent" />
            {t("vip.perk.rewards", { mul: formatDecimal(vip.rewardMul) })}
          </li>
        ) : null}
        <li className="flex items-center gap-2">
          <Sparkles size={16} aria-hidden="true" className="text-accent" />
          {t("vip.perk.noAds")}
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

export function ItemCard(props: { item: ShopItem; index: number; busy: string | null; onBuy: () => void }): ReactNode {
  const { item } = props;
  const name = itemName(item);
  const textKey = `shop.sku.${item.sku}.text`;
  const stars = item.stars;
  return (
    <Card appearIndex={props.index + 1} stripe={item.kind === "starter" ? "accent" : undefined} disabled={item.owned}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-base font-bold text-text">{name}</p>
          {hasTranslation(textKey) ? <p className="text-xs text-text-muted">{t(textKey)}</p> : null}
        </div>
        {item.once && !item.owned ? <Badge tone="accent">{t("shop.once")}</Badge> : null}
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
          <Button
            block
            variant="stars"
            disabled={props.busy !== null}
            loading={props.busy === item.sku}
            ariaLabel={t("shop.buy", { name, stars, n: stars })}
            onClick={props.onBuy}
          >
            <StarsIcon size={18} />
            <span className="tabular-nums">{formatNumber(stars)}</span>
          </Button>
        </div>
      )}
    </Card>
  );
}

/**
 * Вид ресурса различается и цветом, и формой значка — одним цветом он не
 * передаётся (docs/27-design-system-and-app-shell.md §4.4). Осколки — общим
 * значком цвета своей редкости, как в арсенале и на колесе; незнакомое —
 * нейтральным осколком.
 */
export function ResourceIcon(props: { resource: string }): ReactNode {
  if (props.resource === "coins") return <CoinIcon size={16} />;
  if (props.resource === "gems") return <GemIcon size={16} />;
  return <ShardIcon rarity={shardRarity(props.resource) ?? ""} size={16} />;
}

export function statusLine(vip: VipView): string | null {
  if (vip.until === null) return null;
  const date = dateOf(vip.until);
  if (!vip.active) return t("vip.ended", { date });
  if (vip.renewal === "on") return t("vip.until.on", { date });
  return t(vip.renewal === "failed" ? "vip.until.failed" : "vip.until.cancelled", { date });
}

export function dateOf(iso: string | null): string {
  return iso === null ? "—" : DATE.format(new Date(iso));
}
