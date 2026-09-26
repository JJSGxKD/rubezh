import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import {
  creditWithin,
  debitWithin,
  type LedgerLine,
  type Tx,
} from "../wallet/wallet-ledger.js";
import type { SpendReason, WalletResource } from "../wallet/wallet-types.js";
import {
  ITEM_RARITIES,
  ITEM_SLOTS,
  ITEM_STATS,
  type ItemRarity,
  type ItemSlot,
} from "./item-catalog.js";
import type { ItemRolls } from "./item-rules.js";

/**
 * Инвентарь и журнал предметов (docs/35-stage4-plan.md §3.4, WP7).
 *
 * Все изменения одного аккаунта идут по очереди — под транзакционной
 * блокировкой на аккаунт: надеть, улучшить и разобрать один предмет
 * одновременно нельзя, а поштучные блокировки строк при объединении трёх
 * предметов пришлось бы брать в одном порядке у всех. Нагрузки на одного
 * игрока это не создаёт — он делает одно действие за раз.
 *
 * Изменение предмета, списание монет и осколков и строка журнала — одна
 * транзакция (кошелёк — `wallet-ledger.ts`): заплатил — значит, предмет
 * изменился, и наоборот. Повтор с тем же ключом находит свою строку журнала
 * и ничего не меняет.
 */

const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;

export type ItemEventKind =
  | "obtained"
  | "equipped"
  | "unequipped"
  | "upgraded"
  | "rerolled"
  | "salvaged"
  | "merged";

export interface ItemRow {
  itemId: string;
  accountId: string;
  slot: ItemSlot;
  rarity: ItemRarity;
  level: number;
  seed: number;
  rolls: ItemRolls;
  equipped: boolean;
  source: string;
  createdAt: Date;
}

/** Что сделать с предметом — решает сервис по заблокированной строке. */
export interface ItemChange {
  debit?: { lines: readonly LedgerLine[]; reason: SpendReason };
  credit?: { resource: WalletResource; amount: number };
  level?: number;
  rolls?: ItemRolls;
  equipped?: boolean;
  remove?: boolean;
  kind: ItemEventKind;
  payload: Record<string, unknown>;
}

export interface NewItem {
  slot: ItemSlot;
  rarity: ItemRarity;
  level: number;
  seed: number;
  rolls: ItemRolls;
  source: string;
  /** сразу разобрать: инвентарь полон, а выпавшее не должно пропасть */
  salvageTo?: { resource: WalletResource; amount: number };
}

export interface MergeDecision {
  debit: { lines: readonly LedgerLine[]; reason: SpendReason };
  result: NewItem;
}

export interface AccountView {
  level: number;
  alive: number;
}

export type Outcome = { item: ItemRow; duplicate: boolean };

export const ITEMS_REPOSITORY = Symbol("ITEMS_REPOSITORY");

export interface ItemsRepository {
  alive(accountId: string): Promise<ItemRow[]>;
  /** уровень аккаунта: от него потолок уровня предметов и цена улучшения */
  accountLevel(accountId: string): Promise<number>;
  /** `null` — предмета нет у аккаунта или он уже убран */
  change(
    accountId: string,
    itemId: string,
    key: string,
    at: Date,
    decide: (item: ItemRow, account: AccountView) => ItemChange,
  ): Promise<Outcome | null>;
  /** `null` — решено ничего не создавать */
  create(
    accountId: string,
    key: string,
    at: Date,
    decide: (account: AccountView) => NewItem | null,
  ): Promise<Outcome | null>;
  /** `null` — какого-то из предметов нет */
  merge(
    accountId: string,
    itemIds: readonly string[],
    key: string,
    at: Date,
    decide: (items: ItemRow[], account: AccountView) => MergeDecision,
  ): Promise<Outcome | null>;
}

const rollsSchema = z.object({
  main: z.object({ stat: z.enum(ITEM_STATS), roll: z.number() }),
  extras: z.array(z.object({ stat: z.enum(ITEM_STATS), roll: z.number() })),
});

interface RawItem {
  item_id: string;
  account_id: string;
  slot: string;
  rarity: string;
  level: number;
  seed: bigint;
  rolls: unknown;
  equipped: boolean;
  source: string;
  created_at: Date;
}

/** Строка из базы — через схему: броски — JSON, а JSON из базы разбирается, а не приводится. */
function toRow(raw: RawItem): ItemRow {
  return {
    itemId: raw.item_id,
    accountId: raw.account_id,
    slot: z.enum(ITEM_SLOTS).parse(raw.slot),
    rarity: z.enum(ITEM_RARITIES).parse(raw.rarity),
    level: raw.level,
    seed: Number(raw.seed),
    rolls: rollsSchema.parse(raw.rolls),
    equipped: raw.equipped,
    source: raw.source,
    createdAt: raw.created_at,
  };
}

/** Сигнал отката: транзакция откатывается, а наружу уходит найденная строка. */
class Duplicate extends Error {
  constructor(readonly item: ItemRow) {
    super("duplicate");
  }
}

@Injectable()
export class PrismaItemsRepository implements ItemsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async alive(accountId: string): Promise<ItemRow[]> {
    const rows = await this.prisma.$queryRaw<RawItem[]>`
      SELECT item_id, account_id, slot, rarity, level, seed, rolls, equipped, source, created_at
      FROM item WHERE account_id = ${accountId}::uuid AND removed_at IS NULL
      ORDER BY created_at DESC
    `;
    return rows.map(toRow);
  }

  async accountLevel(accountId: string): Promise<number> {
    const [progress] = await this.prisma.$queryRaw<
      { level: number }[]
    >`SELECT level FROM account_progress WHERE account_id = ${accountId}::uuid`;
    return progress?.level ?? 1;
  }

  async change(
    accountId: string,
    itemId: string,
    key: string,
    at: Date,
    decide: (item: ItemRow, account: AccountView) => ItemChange,
  ): Promise<Outcome | null> {
    return await this.transaction(accountId, key, async (tx, account) => {
      const [raw] = await tx.$queryRaw<RawItem[]>`
        SELECT item_id, account_id, slot, rarity, level, seed, rolls, equipped, source, created_at
        FROM item WHERE item_id = ${itemId}::uuid AND account_id = ${accountId}::uuid AND removed_at IS NULL
      `;
      if (raw === undefined) return null;
      const item = toRow(raw);
      const change = decide(item, account);

      if (change.debit !== undefined && change.debit.lines.length > 0) {
        await debitWithin(tx, {
          accountId,
          lines: change.debit.lines,
          reason: change.debit.reason,
          source: `item:${itemId}`,
          idempotencyKey: `item:${key}`,
          at,
        });
      }
      if (change.credit !== undefined && change.credit.amount > 0) {
        await creditWithin(tx, {
          accountId,
          resource: change.credit.resource,
          amount: change.credit.amount,
          reason: "salvage",
          source: `item:${itemId}`,
          idempotencyKey: `item:${key}:credit`,
          at,
        });
      }
      if (change.equipped === true) {
        // Прежний предмет слота снимается в той же транзакции: частичный
        // уникальный индекс не пустит второй надетый.
        await tx.$executeRaw`
          UPDATE item SET equipped = false, updated_at = ${at}
          WHERE account_id = ${accountId}::uuid AND slot = ${item.slot}::"ItemSlot" AND equipped AND removed_at IS NULL AND item_id <> ${itemId}::uuid
        `;
      }
      const next: ItemRow = {
        ...item,
        level: change.level ?? item.level,
        rolls: change.rolls ?? item.rolls,
        equipped:
          change.remove === true ? false : (change.equipped ?? item.equipped),
      };
      await tx.$executeRaw`
        UPDATE item SET level = ${next.level}, rolls = ${JSON.stringify(next.rolls)}::jsonb, equipped = ${next.equipped},
          updated_at = ${at}, removed_at = ${change.remove === true ? at : null}
        WHERE item_id = ${itemId}::uuid
      `;
      await this.event(
        tx,
        itemId,
        accountId,
        change.kind,
        change.payload,
        key,
        at,
      );
      return next;
    });
  }

  async create(
    accountId: string,
    key: string,
    at: Date,
    decide: (account: AccountView) => NewItem | null,
  ): Promise<Outcome | null> {
    return await this.transaction(accountId, key, async (tx, account) => {
      const next = decide(account);
      if (next === null) return null;
      const item = await this.insert(tx, accountId, next, at);
      await this.event(
        tx,
        item.itemId,
        accountId,
        "obtained",
        { source: next.source, rarity: next.rarity, level: next.level },
        key,
        at,
      );
      if (next.salvageTo !== undefined) {
        await creditWithin(tx, {
          accountId,
          resource: next.salvageTo.resource,
          amount: next.salvageTo.amount,
          reason: "salvage",
          source: `item:${item.itemId}`,
          idempotencyKey: `item:${key}:credit`,
          at,
        });
        await tx.$executeRaw`UPDATE item SET removed_at = ${at} WHERE item_id = ${item.itemId}::uuid`;
        await this.event(
          tx,
          item.itemId,
          accountId,
          "salvaged",
          { reason: "inventory_full", shards: next.salvageTo.amount },
          `${key}:salvage`,
          at,
        );
      }
      return item;
    });
  }

  async merge(
    accountId: string,
    itemIds: readonly string[],
    key: string,
    at: Date,
    decide: (items: ItemRow[], account: AccountView) => MergeDecision,
  ): Promise<Outcome | null> {
    return await this.transaction(accountId, key, async (tx, account) => {
      const raws = await tx.$queryRaw<RawItem[]>`
        SELECT item_id, account_id, slot, rarity, level, seed, rolls, equipped, source, created_at
        FROM item WHERE account_id = ${accountId}::uuid AND removed_at IS NULL AND item_id = ANY(${[...itemIds]}::uuid[])
      `;
      if (raws.length !== new Set(itemIds).size) return null;
      const decision = decide(raws.map(toRow), account);

      await tx.$executeRaw`UPDATE item SET removed_at = ${at}, equipped = false, updated_at = ${at} WHERE item_id = ANY(${[...itemIds]}::uuid[])`;
      const result = await this.insert(tx, accountId, decision.result, at);
      // Источник траты — собранный предмет: по нему журнал кошелька находит,
      // за что заплачено, а три исходных — в журнале предметов.
      await debitWithin(tx, {
        accountId,
        lines: decision.debit.lines,
        reason: decision.debit.reason,
        source: `item:${result.itemId}`,
        idempotencyKey: `item:${key}`,
        at,
      });
      for (const itemId of itemIds)
        await this.event(
          tx,
          itemId,
          accountId,
          "merged",
          { into: result.itemId },
          `${key}:${itemId}`,
          at,
        );
      await this.event(
        tx,
        result.itemId,
        accountId,
        "obtained",
        { source: decision.result.source, from: [...itemIds] },
        key,
        at,
      );
      return result;
    });
  }

  /**
   * Транзакция изменения аккаунта: блокировка аккаунта, проверка ключа и
   * уровень аккаунта для правил. `null` из тела — изменять нечего, и
   * транзакция откатывается целиком.
   */
  private async transaction(
    accountId: string,
    key: string,
    body: (tx: Tx, account: AccountView) => Promise<ItemRow | null>,
  ): Promise<Outcome | null> {
    try {
      const item = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`items:${accountId}`}))`;
        const done = await this.byKey(tx, key);
        if (done !== null) throw new Duplicate(done);
        const account = await this.account(tx, accountId);
        const result = await body(tx, account);
        if (result === null) throw new Nothing();
        return result;
      }, TX_OPTIONS);
      return { item, duplicate: false };
    } catch (error: unknown) {
      if (error instanceof Duplicate)
        return { item: error.item, duplicate: true };
      if (error instanceof Nothing) return null;
      throw error;
    }
  }

  private async byKey(tx: Tx, key: string): Promise<ItemRow | null> {
    const [raw] = await tx.$queryRaw<RawItem[]>`
      SELECT i.item_id, i.account_id, i.slot, i.rarity, i.level, i.seed, i.rolls, i.equipped, i.source, i.created_at
      FROM item_event e JOIN item i ON i.item_id = e.item_id WHERE e.idempotency_key = ${key}
    `;
    return raw === undefined ? null : toRow(raw);
  }

  private async account(tx: Tx, accountId: string): Promise<AccountView> {
    const [progress] = await tx.$queryRaw<
      { level: number }[]
    >`SELECT level FROM account_progress WHERE account_id = ${accountId}::uuid`;
    const [count] = await tx.$queryRaw<
      { alive: bigint }[]
    >`SELECT count(*) AS alive FROM item WHERE account_id = ${accountId}::uuid AND removed_at IS NULL`;
    return { level: progress?.level ?? 1, alive: Number(count?.alive ?? 0n) };
  }

  private async insert(
    tx: Tx,
    accountId: string,
    next: NewItem,
    at: Date,
  ): Promise<ItemRow> {
    const itemId = randomUUID();
    await tx.$executeRaw`
      INSERT INTO item (item_id, account_id, slot, rarity, level, seed, rolls, equipped, source, created_at, updated_at)
      VALUES (${itemId}::uuid, ${accountId}::uuid, ${next.slot}::"ItemSlot", ${next.rarity}::"ItemRarity", ${next.level},
              ${BigInt(next.seed)}, ${JSON.stringify(next.rolls)}::jsonb, false, ${next.source}, ${at}, ${at})
    `;
    return {
      itemId,
      accountId,
      slot: next.slot,
      rarity: next.rarity,
      level: next.level,
      seed: next.seed,
      rolls: next.rolls,
      equipped: false,
      source: next.source,
      createdAt: at,
    };
  }

  private async event(
    tx: Tx,
    itemId: string,
    accountId: string,
    kind: ItemEventKind,
    payload: Record<string, unknown>,
    key: string,
    at: Date,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO item_event (event_id, item_id, account_id, kind, payload, idempotency_key, created_at)
      VALUES (${randomUUID()}::uuid, ${itemId}::uuid, ${accountId}::uuid, ${kind}, ${JSON.stringify(payload)}::jsonb, ${key}, ${at})
    `;
  }
}

/** Сигнал отката: изменять нечего — предмета нет или решено не создавать. */
class Nothing extends Error {
  constructor() {
    super("nothing");
  }
}
