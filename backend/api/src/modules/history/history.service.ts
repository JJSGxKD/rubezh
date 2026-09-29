import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { ValidationError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { HISTORY_CATEGORIES, walletCategory, type HistoryCategory, type HistoryEntry } from "./history-types.js";
import { HISTORY_REPOSITORY, type HistoryCursor, type HistoryRepository } from "./history.repository.js";

/**
 * История имущества (docs/35-stage4-plan.md Р51, §3.17): журналы кошелька,
 * предметов и покупок одной лентой, новыми сверху. Каждый журнал отдаёт
 * страницу после курсора, а лента берёт из их слияния первые — так
 * постраничность верна для любой смеси категорий. Только своё: аккаунт — из
 * токена.
 */

const DB_TIMEOUT_MS = 3_000;
export const HISTORY_PAGE_DEFAULT = 30;
export const HISTORY_PAGE_MAX = 50;

export interface HistoryView {
  entries: HistoryEntry[];
  nextCursor: string | null;
}

interface Sorted {
  at: Date;
  key: string;
  entry: HistoryEntry;
}

const levelSchema = z.object({ to: z.number().int().optional(), level: z.number().int().optional() });

@Injectable()
export class HistoryService {
  constructor(@Inject(HISTORY_REPOSITORY) private readonly repository: HistoryRepository) {}

  async history(accountId: string, categories: readonly HistoryCategory[] = HISTORY_CATEGORIES, cursor?: string, limit = HISTORY_PAGE_DEFAULT): Promise<HistoryView> {
    const from = cursor === undefined ? null : decodeHistoryCursor(cursor);
    const size = Math.min(Math.max(1, Math.floor(limit)), HISTORY_PAGE_MAX);
    const wanted = new Set(categories);
    const walletCategories = categories.filter((category) => category !== "items");

    // Строкой больше от каждого журнала: так видно, есть ли следующая страница.
    const [wallet, items, purchases] = await withTimeout(
      Promise.all([
        walletCategories.length === 0 ? [] : this.repository.wallet(accountId, walletCategories, from, size + 1),
        wanted.has("items") ? this.repository.items(accountId, from, size + 1) : [],
        wanted.has("purchases") ? this.repository.purchases(accountId, from, size + 1) : [],
      ]),
      DB_TIMEOUT_MS,
      "история имущества",
    );

    const merged: Sorted[] = [
      ...wallet.map((row) => ({
        at: row.at,
        key: row.key,
        entry: { id: row.key, at: row.at.toISOString(), category: walletCategory(row.resource, row.reason), kind: "wallet" as const, resource: row.resource, amount: row.amount, reason: row.reason },
      })),
      ...items.map((row) => {
        const levels = levelSchema.safeParse(row.payload);
        const level = levels.success ? (levels.data.to ?? levels.data.level ?? null) : null;
        return {
          at: row.at,
          key: row.key,
          entry: { id: row.key, at: row.at.toISOString(), category: "items" as const, kind: "item" as const, event: row.event, itemId: row.itemId, slot: row.slot, rarity: row.rarity, level },
        };
      }),
      ...purchases.map((row) => ({
        at: row.at,
        key: row.key,
        entry: { id: row.key, at: row.at.toISOString(), category: "purchases" as const, kind: "purchase" as const, product: row.product, stars: row.stars, refunded: row.refunded },
      })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime() || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));

    const page = merged.slice(0, size);
    const last = page[page.length - 1];
    return { entries: page.map((row) => row.entry), nextCursor: merged.length > size && last !== undefined ? encodeHistoryCursor({ at: last.at, key: last.key }) : null };
  }
}

export function encodeHistoryCursor(cursor: HistoryCursor): string {
  return Buffer.from(`${String(cursor.at.getTime())}|${cursor.key}`, "utf8").toString("base64url");
}

const CURSOR = /^(\d{1,15})\|([wip]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function decodeHistoryCursor(value: string): HistoryCursor {
  const match = CURSOR.exec(Buffer.from(value, "base64url").toString("utf8"));
  if (match?.[1] === undefined || match[2] === undefined) throw new ValidationError("Некорректный курсор истории");
  return { at: new Date(Number(match[1])), key: match[2] };
}
