import { formatNumber, hasTranslation, t } from "../../i18n";
import "../../i18n/shop";
import type { ShopItem } from "../../state/shop-api";
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
