import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { BOOST_REASONS, ITEM_HISTORY_EVENTS, PURCHASE_REASONS, type HistoryCategory } from "./history-types.js";

/**
 * Чтение журналов для истории имущества — модель чтения поверх таблиц
 * кошелька, предметов и покупок. Писать сюда нечего: история — не копия,
 * а взгляд на журналы, поэтому и не расходится с ними.
 *
 * Лента — по курсору: время и ключ строки с приставкой источника (`w:`,
 * `i:`, `p:`), чтобы строки одного мгновения из разных журналов шли в одном
 * порядке и не терялись на границе страницы.
 */

export interface HistoryCursor {
  at: Date;
  key: string;
}

export interface WalletRow {
  key: string;
  at: Date;
  resource: string;
  amount: number;
  reason: string;
}

export interface ItemEventRow {
  key: string;
  at: Date;
  event: string;
  itemId: string;
  slot: string;
  rarity: string;
  payload: unknown;
}

export interface PurchaseRow {
  key: string;
  at: Date;
  product: string;
  stars: number;
  refunded: boolean;
}

export const HISTORY_REPOSITORY = Symbol("HISTORY_REPOSITORY");

export interface HistoryRepository {
  /** строки кошелька только выбранных категорий: фильтр — в запросе, чтобы страница не пустела */
  wallet(accountId: string, categories: readonly HistoryCategory[], cursor: HistoryCursor | null, limit: number): Promise<WalletRow[]>;
  items(accountId: string, cursor: HistoryCursor | null, limit: number): Promise<ItemEventRow[]>;
  purchases(accountId: string, cursor: HistoryCursor | null, limit: number): Promise<PurchaseRow[]>;
}

const walletSchema = z.array(z.object({ key: z.string(), at: z.date(), resource: z.string(), amount: z.bigint(), reason: z.string() }));
const itemSchema = z.array(z.object({ key: z.string(), at: z.date(), event: z.string(), item_id: z.string(), slot: z.string(), rarity: z.string(), payload: z.unknown() }));
const purchaseSchema = z.array(z.object({ key: z.string(), at: z.date(), product: z.string(), stars: z.number().int(), refunded: z.boolean() }));

/**
 * Категория строки кошелька — то же правило, что `walletCategory`: бусты и
 * покупки — по причине, остальное делят ресурсы.
 */
function walletFilter(categories: readonly HistoryCategory[]): Prisma.Sql {
  const boosts = Prisma.join([...BOOST_REASONS]);
  const purchases = Prisma.join([...PURCHASE_REASONS]);
  const other = Prisma.sql`reason NOT IN (${boosts}) AND reason NOT IN (${purchases})`;
  const parts = categories.flatMap((category): Prisma.Sql[] => {
    switch (category) {
      case "boosts":
        return [Prisma.sql`reason IN (${boosts})`];
      case "purchases":
        return [Prisma.sql`reason IN (${purchases})`];
      case "shards":
        return [Prisma.sql`(resource::text LIKE 'shard\_%' AND ${other})`];
      case "currency":
        return [Prisma.sql`(resource::text NOT LIKE 'shard\_%' AND ${other})`];
      default:
        return [];
    }
  });
  return parts.length === 0 ? Prisma.sql`FALSE` : Prisma.sql`(${Prisma.join(parts, " OR ")})`;
}

/** Условие курсора для выражений времени и ключа источника. */
function after(cursor: HistoryCursor | null, at: Prisma.Sql, key: Prisma.Sql): Prisma.Sql {
  return cursor === null ? Prisma.sql`TRUE` : Prisma.sql`(${at}, ${key}) < (${cursor.at}, ${cursor.key})`;
}

@Injectable()
export class PrismaHistoryRepository implements HistoryRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async wallet(accountId: string, categories: readonly HistoryCategory[], cursor: HistoryCursor | null, limit: number): Promise<WalletRow[]> {
    const key = Prisma.sql`('w:' || entry_id::text)`;
    const rows = await this.prisma.$queryRaw`
      SELECT ${key} AS key, created_at AS at, resource::text AS resource, amount, reason
      FROM wallet_entry
      WHERE account_id = ${accountId}::uuid AND amount <> 0 AND ${walletFilter(categories)}
        AND ${after(cursor, Prisma.sql`created_at`, key)}
      ORDER BY created_at DESC, key DESC LIMIT ${limit}`;
    return walletSchema.parse(rows).map((row) => ({ ...row, amount: Number(row.amount) }));
  }

  async items(accountId: string, cursor: HistoryCursor | null, limit: number): Promise<ItemEventRow[]> {
    const key = Prisma.sql`('i:' || e.event_id::text)`;
    const rows = await this.prisma.$queryRaw`
      SELECT ${key} AS key, e.created_at AS at, e.kind AS event, e.item_id, i.slot::text AS slot, i.rarity::text AS rarity, e.payload
      FROM item_event e JOIN item i ON i.item_id = e.item_id
      WHERE e.account_id = ${accountId}::uuid AND e.kind IN (${Prisma.join([...ITEM_HISTORY_EVENTS])})
        AND ${after(cursor, Prisma.sql`e.created_at`, key)}
      ORDER BY e.created_at DESC, key DESC LIMIT ${limit}`;
    return itemSchema.parse(rows).map((row) => ({ key: row.key, at: row.at, event: row.event, itemId: row.item_id, slot: row.slot, rarity: row.rarity, payload: row.payload }));
  }

  async purchases(accountId: string, cursor: HistoryCursor | null, limit: number): Promise<PurchaseRow[]> {
    const key = Prisma.sql`('p:' || purchase_id::text)`;
    const rows = await this.prisma.$queryRaw`
      SELECT ${key} AS key, paid_at AS at, product::text AS product, charged_stars AS stars, (refunded_at IS NOT NULL) AS refunded
      FROM purchase
      WHERE account_id = ${accountId}::uuid AND paid_at IS NOT NULL AND ${after(cursor, Prisma.sql`paid_at`, key)}
      ORDER BY paid_at DESC, key DESC LIMIT ${limit}`;
    return purchaseSchema.parse(rows);
  }
}
