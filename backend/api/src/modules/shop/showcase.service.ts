import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { ITEM_SLOTS, type ItemRarity, type ItemSlot, type ItemStat } from "../items/item-catalog.js";
import { itemPower, rollItem, seededRandom, statValue, type ItemShape } from "../items/item-rules.js";
import type { ItemView } from "../items/item-views.js";
import { ItemsService, type SeedSource } from "../items/items.service.js";
import { ShowcaseExpiredError, ShowcaseOfferNotFoundError, ShowcaseSoldError } from "./shop-errors.js";
import { SHOWCASE_OFFERS, offerFor, showcaseLevel } from "./showcase-plan.js";
import { SHOWCASE_REPOSITORY, type NewShowcaseOffer, type ShowcaseRepository, type ShowcaseRow } from "./showcase.repository.js";

/**
 * Витрина снаряжения (docs/35-stage4-plan.md §3.6, Р11; WP10): каждые
 * игровые сутки — свои конкретные предметы с уже брошенными свойствами, за
 * самоцветы. Игрок видит ровно то, что купит: предложение выставляется при
 * первом открытии суток и хранится, а покупка выдаёт его как есть.
 *
 * Обновление витрины не продаётся (Р11): новые предметы — только с новыми
 * сутками. Списание и предмет — одна транзакция модуля предметов, ключом
 * предложения: повтор после обрыва найдёт купленное и не спишет второй раз.
 */

const DB_TIMEOUT_MS = 3_000;

/** Зёрна витрины: в бою — криптографические, как у добычи; тесты подают свои. */
export const SHOWCASE_SEEDS = Symbol("SHOWCASE_SEEDS");

export interface ShowcaseOfferView {
  offerId: string;
  slot: ItemSlot;
  rarity: ItemRarity;
  level: number;
  power: number;
  main: { stat: ItemStat; value: number };
  extras: { stat: ItemStat; value: number }[];
  gems: number;
  sold: boolean;
}

export interface ShowcaseView {
  offers: ShowcaseOfferView[];
}

export interface ShowcaseBuyResult {
  item: ItemView;
  view: ShowcaseView;
}

@Injectable()
export class ShowcaseService {
  private readonly logger = new Logger("shop");

  constructor(
    @Inject(SHOWCASE_REPOSITORY) private readonly repository: ShowcaseRepository,
    private readonly items: ItemsService,
    @Inject(SHOWCASE_SEEDS) private readonly seeds: SeedSource,
  ) {}

  async view(accountId: string, at = new Date()): Promise<ShowcaseView> {
    return { offers: (await this.offers(accountId, at)).map(offerView) };
  }

  async buy(accountId: string, offerId: string, at = new Date()): Promise<ShowcaseBuyResult> {
    const [offer, today] = await Promise.all([this.db(this.repository.byId(accountId, offerId)), this.db(this.repository.today(accountId, at))]);
    if (offer === null) throw new ShowcaseOfferNotFoundError();
    if (offer.gameDay !== today.gameDay) throw new ShowcaseExpiredError();
    if (offer.soldAt !== null) throw new ShowcaseSoldError();

    const bought = await this.items.buy(
      accountId,
      `showcase:${offer.offerId}`,
      {
        shape: { slot: offer.slot, rarity: offer.rarity, level: offer.level, seed: offer.seed, rolls: offer.rolls, source: `showcase:${offer.offerId}` },
        price: [{ resource: "gems", amount: offer.priceGems }],
      },
      at,
    );
    // Предмет уже у игрока: отметка — после, и её повтор ничего не меняет.
    await this.db(this.repository.markSold(accountId, offer.offerId, bought.item.itemId, at));
    if (!bought.duplicate) {
      this.logger.log(JSON.stringify({ module: "shop", event: "showcase_bought", accountId, offerId, rarity: offer.rarity, gems: offer.priceGems }));
    }
    return { item: bought.item, view: await this.view(accountId, at) };
  }

  /** Витрина суток: при первом открытии выставляется, дальше — та же до полуночи по Москве. */
  private async offers(accountId: string, at: Date): Promise<ShowcaseRow[]> {
    const today = await this.db(this.repository.today(accountId, at));
    if (today.offers.length > 0) return today.offers;
    const level = await this.db(this.repository.accountLevel(accountId));
    await this.db(this.repository.fill(accountId, today.gameDay, this.roll(level), at));
    return (await this.db(this.repository.today(accountId, at))).offers;
  }

  /** Предложения суток: слоты не повторяются, свойства брошены зерном предмета — как у добычи. */
  private roll(accountLevel: number): NewShowcaseOffer[] {
    const slots = shuffled(seededRandom(this.seeds()), ITEM_SLOTS);
    const level = showcaseLevel(accountLevel);
    const offers: NewShowcaseOffer[] = [];
    SHOWCASE_OFFERS.forEach((plan, position) => {
      const placed = offerFor(plan, accountLevel);
      const slot = slots[position % slots.length];
      if (placed === null || slot === undefined) return;
      const seed = this.seeds();
      offers.push({ offerId: randomUUID(), position, slot, rarity: placed.rarity, level, seed, rolls: rollItem(seededRandom(seed), slot, placed.rarity), priceGems: placed.gems });
    });
    return offers;
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "витрина");
  }
}

/** Предложение глазами клиента: значения посчитаны сервером, как у предмета в арсенале. */
export function offerView(row: ShowcaseRow): ShowcaseOfferView {
  const shape: ItemShape = row;
  return {
    offerId: row.offerId,
    slot: row.slot,
    rarity: row.rarity,
    level: row.level,
    power: itemPower(shape),
    main: { stat: row.rolls.main.stat, value: statValue(row.rolls.main.stat, row.rarity, row.level, row.rolls.main.roll) },
    extras: row.rolls.extras.map((extra) => ({ stat: extra.stat, value: statValue(extra.stat, row.rarity, row.level, extra.roll) })),
    gems: row.priceGems,
    sold: row.soldAt !== null,
  };
}

/** Перемешать по броскам генератора — Фишер — Йейтс. */
function shuffled<T>(random: () => number, values: readonly T[]): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    const current = result[index];
    const swap = result[other];
    if (current === undefined || swap === undefined) continue;
    result[index] = swap;
    result[other] = current;
  }
  return result;
}
