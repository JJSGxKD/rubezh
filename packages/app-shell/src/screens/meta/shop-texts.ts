import { formatNumber, hasTranslation, t } from "../../i18n";
import "../../i18n/shop";
import type { ShopItem, ShopView, VipView } from "../../state/shop-api";
import type { BuyOutcome } from "../../state/shop-purchase";

/**
 * Тексты магазина, которые собираются из данных сервера: имя товара, состав,
 * исход покупки. Отдельно от экрана — чтобы проверять их тестом без React.
 */

export type Notice = { tone: "success" | "error"; text: string } | null;

export function resourceLabel(resource: string, amount: number): string {
  const key = `shop.resource.${resource}`;
  return hasTranslation(key) ? t(key, { amount: formatNumber(amount), n: amount }) : formatNumber(amount);
}

/** Имя товара — из словаря; товар новее клиента называется своим составом. */
export function itemName(item: Pick<ShopItem, "sku" | "contents">): string {
  const key = `shop.sku.${item.sku}.name`;
  if (hasTranslation(key)) return t(key);
  return item.contents.map((part) => resourceLabel(part.resource, part.amount)).join(", ");
}

export function noticeOf(outcome: BuyOutcome, name: string): Notice {
  switch (outcome.kind) {
    case "done":
      return { tone: "success", text: t("shop.done", { name }) };
    case "cancelled":
      return null;
    case "retry":
      return { tone: "error", text: t(`shop.retry.${outcome.reason}`) };
    case "refused": {
      const key = `shop.refused.${outcome.code}`;
      return { tone: "error", text: hasTranslation(key) ? t(key) : t("shop.refused") };
    }
  }
}

/** Отказ в покупке с витрины — что сказать и перечитать ли витрину: она могла устареть. */
export function showcaseRefusal(code: string | undefined): { text: string; reload: boolean } {
  switch (code) {
    case "insufficient_funds":
      return { text: t("showcase.noGems"), reload: false };
    case "inventory_full":
      return { text: t("showcase.full"), reload: false };
    case "showcase_sold":
    case "showcase_expired":
    case "showcase_offer_not_found":
      return { text: t("showcase.stale"), reload: true };
    default:
      return { text: t("showcase.failed"), reload: false };
  }
}

/**
 * Баннер главной полосы магазина — что предложить игроку на первом экране
 * (решение участника 1: магазин с баннерами и маркетингом). Порядок — по
 * ценности для игрока и игры: VIP, пока его нет; стартовый набор, пока не
 * куплен; подобранный сервером товар; снаряжение дня; звёзды через Tribute.
 */
export type ShopBanner =
  | { kind: "vip"; stars: number }
  | { kind: "starter"; item: ShopItem }
  | { kind: "recommended"; item: ShopItem }
  | { kind: "gear" }
  | { kind: "tribute"; url: string };

function sellable(item: ShopItem | undefined): item is ShopItem {
  return item !== undefined && item.stars !== null && !(item.once && item.owned);
}

export function shopBanners(shop: ShopView, vip: VipView | null): ShopBanner[] {
  const banners: ShopBanner[] = [];
  if (vip !== null && !vip.active && vip.canOrder && vip.stars !== null) banners.push({ kind: "vip", stars: vip.stars });
  const starter = shop.items.find((item) => item.kind === "starter");
  if (sellable(starter)) banners.push({ kind: "starter", item: starter });
  const recommended = shop.items.find((item) => item.sku === shop.recommended);
  if (sellable(recommended) && recommended.sku !== starter?.sku) banners.push({ kind: "recommended", item: recommended });
  banners.push({ kind: "gear" });
  const tribute = tributeOf(shop);
  if (tribute !== null) banners.push({ kind: "tribute", url: tribute });
  return banners;
}

/** Ссылка на звёзды через Tribute: только https — иначе плашки нет, как и без ссылки. */
export function tributeOf(shop: Pick<ShopView, "tribute">): string | null {
  const url = shop.tribute;
  if (typeof url !== "string" || url === "") return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Вкладки магазина. Три, а не четыре: «Самоцветы» и «Снаряжение» вчетвером
 * не помещаются на узкий телефон. VIP живёт на «Для вас» и в баннере, а знак
 * на вкладке — самоцветы дня VIP ждут забора.
 */
export type ShopTab = "featured" | "gems" | "gear";

export function vipWaiting(vip: VipView | null): number {
  return vip !== null && vip.active && !vip.daily.claimed ? 1 : 0;
}

/** Бейдж товара словами; незнакомый от сервера новее клиента — без бейджа. */
export function badgeLabel(badge: string | null | undefined): string | null {
  if (badge === "hit") return t("shop.badge.hit");
  if (badge === "best") return t("shop.badge.best");
  return null;
}
