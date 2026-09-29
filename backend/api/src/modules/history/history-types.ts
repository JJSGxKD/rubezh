/**
 * История имущества игрока (docs/35-stage4-plan.md Р51, §3.17): все
 * движения валют, осколков, предметов, бустов и покупок одной лентой.
 * Источник — журналы: кошелёк, предметы, покупки за Stars. Отдельной
 * таблицы нет, поэтому история не может разойтись с балансом.
 */

export const HISTORY_CATEGORIES = ["currency", "shards", "items", "boosts", "purchases"] as const;

export type HistoryCategory = (typeof HISTORY_CATEGORIES)[number];

/** Строка кошелька: ресурс со знаком — начисление плюсом, списание минусом. */
export interface WalletHistoryEntry {
  id: string;
  at: string;
  category: Exclude<HistoryCategory, "items">;
  kind: "wallet";
  resource: string;
  amount: number;
  reason: string;
}

/** Событие предмета, которое меняет имущество: получение, улучшение, перековка, разбор, объединение. */
export interface ItemHistoryEntry {
  id: string;
  at: string;
  category: "items";
  kind: "item";
  event: string;
  itemId: string;
  slot: string;
  rarity: string;
  /** уровень после события: у улучшения — новый */
  level: number | null;
}

/** Оплата за Stars: что куплено и сколько списано. */
export interface PurchaseHistoryEntry {
  id: string;
  at: string;
  category: "purchases";
  kind: "purchase";
  product: string;
  stars: number;
  refunded: boolean;
}

export type HistoryEntry = WalletHistoryEntry | ItemHistoryEntry | PurchaseHistoryEntry;

/** Причины кошелька, которые относятся к бустам и к покупкам, — остальное делят ресурсы. */
export const BOOST_REASONS: ReadonlySet<string> = new Set(["boost", "boost_refund"]);
export const PURCHASE_REASONS: ReadonlySet<string> = new Set(["purchase", "shop"]);

export function walletCategory(resource: string, reason: string): WalletHistoryEntry["category"] {
  if (BOOST_REASONS.has(reason)) return "boosts";
  if (PURCHASE_REASONS.has(reason)) return "purchases";
  return resource.startsWith("shard_") ? "shards" : "currency";
}

/** События предметов, которые меняют имущество: надеть и снять — не движение. */
export const ITEM_HISTORY_EVENTS = ["obtained", "upgraded", "rerolled", "salvaged", "merged"] as const;
