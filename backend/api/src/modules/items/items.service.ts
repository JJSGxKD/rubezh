import { randomInt, randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { DisabledError, ValidationError } from "../../common/domain-error.js";
import { InsufficientFundsError } from "../wallet/wallet-errors.js";
import { InsufficientBalance } from "../wallet/wallet-ledger.js";
import { WalletService } from "../wallet/wallet.service.js";
import type { WalletResource } from "../wallet/wallet-types.js";
import { INVENTORY_CAP, ITEM_SLOTS, MERGE_COUNT, type ItemRarity, type ItemSlot } from "./item-catalog.js";
import { loadoutKey, signLoadout, type LoadoutSnapshot } from "./item-loadout.js";
import { levelCap, loadoutOf, mergeCost, nextRarity, rerollCost, rerollExtra, rollItem, rollLoot, salvageYield, seededRandom, upgradeCost, type RunVerdict } from "./item-rules.js";
import { inventoryView, itemView, type InventoryView, type ItemView } from "./item-views.js";
import { ItemNotFoundError, ItemRuleError } from "./items-errors.js";
import { ITEMS_REPOSITORY, type ItemRow, type ItemsRepository, type Outcome } from "./items.repository.js";

/**
 * Снаряжение (docs/35-stage4-plan.md §3.4, WP7): инвентарь, надеть и снять,
 * улучшение, перековка, разбор, объединение, добыча после забега и
 * подписанный снимок надетого.
 *
 * Правила — в `item-rules.ts`, SQL — в репозитории; здесь — решение по уже
 * заблокированной строке: цена считается от того уровня, что лежит в базе в
 * момент операции, а не от того, что видел клиент.
 *
 * Ключ операции клиент придумывает сам (uuid на нажатие); сервис
 * добавляет к нему аккаунт — чужой ключ не займёт твой.
 */

/**
 * Откуда берутся зёрна бросков. В бою — криптографический генератор: зерно
 * пишется в журнал, и угадать следующее по прошлым нельзя. Тесты подают свои
 * — и получают тот же предмет, что предсказали правила.
 */
export const ITEM_SEEDS = Symbol("ITEM_SEEDS");
export type SeedSource = () => number;
export const cryptoSeeds: SeedSource = () => randomInt(2 ** 31);

export interface RunLoot {
  accountId: string;
  runId: string;
  survivalSec: number;
  difficultyId: string;
  verdict: RunVerdict;
  at: Date;
}

@Injectable()
export class ItemsService {
  private readonly logger = new Logger("items");
  /** `null` — вход выключен и секрета нет: подписать снимок нечем */
  private readonly signingKey: Buffer | null;

  constructor(
    @Inject(ITEMS_REPOSITORY) private readonly items: ItemsRepository,
    private readonly wallet: WalletService,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(ITEM_SEEDS) private readonly seeds: SeedSource,
  ) {
    this.signingKey = config.auth.accessSecret === "" ? null : loadoutKey(config.auth.accessSecret);
  }

  async inventory(accountId: string): Promise<InventoryView> {
    const [rows, level] = await Promise.all([this.items.alive(accountId), this.items.accountLevel(accountId)]);
    return inventoryView(rows, level);
  }

  /** Подписанный снимок надетого — клиент подаёт его на старте забега (Р17). */
  async loadout(accountId: string, nowMs = Date.now()): Promise<LoadoutSnapshot> {
    if (this.signingKey === null) throw new DisabledError("Вход выключен — снимок снаряжения не подписать");
    const equipped = (await this.items.alive(accountId)).filter((item) => item.equipped);
    return signLoadout(this.signingKey, accountId, loadoutOf(equipped), nowMs);
  }

  async equip(accountId: string, itemId: string, at = new Date()): Promise<ItemView> {
    const outcome = await this.items.change(accountId, itemId, `equip:${randomUUID()}`, at, (item) => ({ equipped: true, kind: "equipped", payload: { slot: item.slot } }));
    return await this.viewOf(accountId, outcome);
  }

  async unequip(accountId: string, itemId: string, at = new Date()): Promise<ItemView> {
    const outcome = await this.items.change(accountId, itemId, `unequip:${randomUUID()}`, at, (item) => ({ equipped: false, kind: "unequipped", payload: { slot: item.slot } }));
    return await this.viewOf(accountId, outcome);
  }

  async upgrade(accountId: string, itemId: string, key: string, at = new Date()): Promise<ItemView> {
    const outcome = await this.paid(accountId, () =>
      this.items.change(accountId, itemId, scoped(accountId, key), at, (item, account) => {
        const cost = upgradeCost(item, account.level);
        if (cost === null) throw new ItemRuleError("item_max_level", "Предмет уже на пределе уровня — поднимите уровень аккаунта");
        return {
          debit: { lines: lines(cost.coins, shardOf(item.rarity), cost.shards), reason: "item_upgrade" },
          level: item.level + 1,
          kind: "upgraded",
          payload: { from: item.level, to: item.level + 1, ...cost },
        };
      }),
    );
    return await this.viewOf(accountId, outcome);
  }

  /** Перековка: бросок — новым зерном, и оно пишется в журнал для разбора спорных случаев. */
  async reroll(accountId: string, itemId: string, index: number, key: string, at = new Date()): Promise<ItemView> {
    const seed = this.seeds();
    const outcome = await this.paid(accountId, () =>
      this.items.change(accountId, itemId, scoped(accountId, key), at, (item) => {
        if (item.rolls.extras[index] === undefined) throw new ItemRuleError("item_no_extra", "У предмета нет такого свойства");
        const cost = rerollCost(item);
        const rolls = rerollExtra(seededRandom(seed), item, index);
        return {
          debit: { lines: lines(cost.coins, shardOf(item.rarity), cost.shards), reason: "item_reroll" },
          rolls,
          kind: "rerolled",
          payload: { index, seed, from: item.rolls.extras[index], to: rolls.extras[index], ...cost },
        };
      }),
    );
    return await this.viewOf(accountId, outcome);
  }

  async salvage(accountId: string, itemId: string, key: string, at = new Date()): Promise<{ shards: number; resource: WalletResource }> {
    let shards = 0;
    let resource: WalletResource = "shard_common";
    const outcome = await this.items.change(accountId, itemId, scoped(accountId, key), at, (item) => {
      shards = salvageYield(item);
      resource = shardOf(item.rarity);
      return { credit: { resource, amount: shards }, remove: true, kind: "salvaged", payload: { shards, resource } };
    });
    if (outcome === null) throw new ItemNotFoundError();
    // Повтор разбора ничего не начисляет — отвечаем тем, что дал первый.
    if (outcome.duplicate) return { shards: salvageYield(outcome.item), resource: shardOf(outcome.item.rarity) };
    return { shards, resource };
  }

  /** Три предмета одной редкости — в один случайный следующей (§3.4). */
  async merge(accountId: string, itemIds: readonly string[], key: string, at = new Date()): Promise<ItemView> {
    if (itemIds.length !== MERGE_COUNT || new Set(itemIds).size !== MERGE_COUNT) {
      throw new ValidationError(`Объединяются ровно ${MERGE_COUNT} разных предмета`);
    }
    const seed = this.seeds();
    const outcome = await this.paid(accountId, () =>
      this.items.merge(accountId, itemIds, scoped(accountId, key), at, (items, account) => {
        const rarity = items[0]?.rarity ?? "common";
        if (items.some((item) => item.rarity !== rarity)) throw new ItemRuleError("merge_mismatch", "Объединяются предметы одной редкости");
        const target = nextRarity(rarity);
        const cost = mergeCost(rarity);
        if (target === null || cost === null) throw new ItemRuleError("merge_max_rarity", "Выше этой редкости объединение не собирает");
        const random = seededRandom(seed);
        const slot = pickSlot(random);
        // Уровень лучшего из трёх: объединение не должно обнулять вложенное в улучшения.
        const level = Math.min(Math.max(...items.map((item) => item.level)), levelCap(account.level));
        return {
          debit: { lines: lines(cost.coins, shardOf(rarity), cost.shards), reason: "item_merge" },
          result: { slot, rarity: target, level, seed, rolls: rollItem(random, slot, target), source: `merge:${key}`.slice(0, 96) },
        };
      }),
    );
    return await this.viewOf(accountId, outcome);
  }

  /**
   * Добыча после забега — из задания наград (progress/run-rewards.ts), по
   * ключу забега: повтор задания второй предмет не выдаст. Полный инвентарь
   * выпавшее не теряет — оно сразу разбирается в осколки.
   */
  async dropForRun(input: RunLoot): Promise<ItemRow | null> {
    const seed = this.seeds();
    const outcome = await this.items.create(input.accountId, `loot:${input.runId}`, input.at, (account) => {
      const random = seededRandom(seed);
      const loot = rollLoot(random, { ...input, accountLevel: account.level, replayVerified: false });
      if (loot === null) return null;
      const rolls = rollItem(random, loot.slot, loot.rarity);
      const full = account.alive >= INVENTORY_CAP;
      const shape = { ...loot, rolls };
      return {
        ...shape,
        seed,
        source: `loot:${input.runId}`.slice(0, 96),
        ...(full ? { salvageTo: { resource: shardOf(loot.rarity), amount: salvageYield(shape) } } : {}),
      };
    });
    if (outcome !== null && !outcome.duplicate) {
      this.logger.log(JSON.stringify({ module: "items", event: "loot", accountId: input.accountId, runId: input.runId, rarity: outcome.item.rarity }));
    }
    return outcome?.item ?? null;
  }

  private async viewOf(accountId: string, outcome: Outcome | null): Promise<ItemView> {
    if (outcome === null) throw new ItemNotFoundError();
    return itemView(outcome.item, await this.items.accountLevel(accountId));
  }

  /** Не хватило — не списано ничего, и игрок узнаёт, чего и сколько. */
  private async paid(accountId: string, run: () => Promise<Outcome | null>): Promise<Outcome | null> {
    try {
      return await run();
    } catch (error: unknown) {
      if (!(error instanceof InsufficientBalance)) throw error;
      const balance = (await this.wallet.balances(accountId))[error.resource];
      throw new InsufficientFundsError(error.resource, error.needed, balance);
    }
  }
}

function scoped(accountId: string, key: string): string {
  return `op:${accountId}:${key}`;
}

function shardOf(rarity: ItemRarity): WalletResource {
  return `shard_${rarity}`;
}

function lines(coins: number, shard: WalletResource, shards: number): { resource: WalletResource; amount: number }[] {
  return [
    ...(coins > 0 ? [{ resource: "coins" as const, amount: coins }] : []),
    ...(shards > 0 ? [{ resource: shard, amount: shards }] : []),
  ];
}

function pickSlot(random: () => number): ItemSlot {
  return ITEM_SLOTS[Math.floor(random() * ITEM_SLOTS.length)] ?? "weapon";
}
