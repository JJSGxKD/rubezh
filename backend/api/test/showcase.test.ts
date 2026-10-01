import "reflect-metadata";
import { Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { APP_CONFIG, loadAppConfig } from "../src/config/app-config.js";
import { createHttpApp } from "../src/http-app.js";
import { REDIS } from "../src/infra/redis.js";
import { secretKey, signAccessToken } from "../src/modules/auth/access-token.js";
import { AuthGuard } from "../src/modules/auth/auth.guard.js";
import { RateLimiter } from "../src/modules/ingest/rate-limiter.js";
import { ITEM_SLOTS, MAX_ITEM_LEVEL, RARITY_RULES } from "../src/modules/items/item-catalog.js";
import { levelCap, rollItem, seededRandom } from "../src/modules/items/item-rules.js";
import { ItemRuleError } from "../src/modules/items/items-errors.js";
import type { ItemsService, PurchasedItem } from "../src/modules/items/items.service.js";
import { ShopController } from "../src/modules/shop/shop.controller.js";
import { ShowcaseExpiredError, ShowcaseOfferNotFoundError, ShowcaseSoldError } from "../src/modules/shop/shop-errors.js";
import { ShopService } from "../src/modules/shop/shop.service.js";
import { SHOWCASE_OFFERS, offerFor, showcaseLevel } from "../src/modules/shop/showcase-plan.js";
import type { NewShowcaseOffer, ShowcaseRepository, ShowcaseRow } from "../src/modules/shop/showcase.repository.js";
import { ShowcaseService, offerView } from "../src/modules/shop/showcase.service.js";
import { InsufficientFundsError } from "../src/modules/wallet/wallet-errors.js";
import { AUTH_ENV } from "./helpers/auth-env.js";

/**
 * Витрина снаряжения (docs/35-stage4-plan.md §3.6, Р11; WP10): на сутки —
 * свои конкретные предметы, покупается ровно показанное, за самоцветы,
 * однажды; обновление не продаётся — новые предметы только с новыми сутками.
 */

const ME = "00000000-0000-4000-8000-0000000005c1";
const HOUR = 3_600_000;
/** среда, 30.09.2026, 12:00 по Москве */
const NOON = new Date(Date.UTC(2026, 8, 30, 9));
const TOMORROW = new Date(NOON.getTime() + 24 * HOUR);

/** Игровые сутки по Москве: UTC+3 без перехода на летнее время. */
function moscowDay(at: Date): string {
  return new Date(at.getTime() + 3 * HOUR).toISOString().slice(0, 10);
}

class MemoryShowcase implements ShowcaseRepository {
  readonly rows: ShowcaseRow[] = [];
  level = 1;
  fills = 0;

  async today(accountId: string, at: Date): Promise<{ gameDay: string; offers: ShowcaseRow[] }> {
    const gameDay = moscowDay(at);
    const offers = this.rows.filter((row) => row.accountId === accountId && row.gameDay === gameDay).sort((a, b) => a.position - b.position);
    return { gameDay, offers: offers.map((row) => ({ ...row })) };
  }

  async fill(accountId: string, gameDay: string, offers: readonly NewShowcaseOffer[]): Promise<void> {
    this.fills++;
    // Как в базе: выставленные сутки второй раз не выставляются — целиком.
    if (this.rows.some((row) => row.accountId === accountId && row.gameDay === gameDay)) return;
    for (const offer of offers) this.rows.push({ ...offer, accountId, gameDay, soldAt: null, itemId: null });
  }

  async byId(accountId: string, offerId: string): Promise<ShowcaseRow | null> {
    const row = this.rows.find((candidate) => candidate.offerId === offerId && candidate.accountId === accountId);
    return row === undefined ? null : { ...row };
  }

  async markSold(accountId: string, offerId: string, itemId: string, at: Date): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.offerId === offerId && candidate.accountId === accountId);
    if (row === undefined || row.soldAt !== null) return false;
    row.soldAt = at;
    row.itemId = itemId;
    return true;
  }

  async accountLevel(): Promise<number> {
    return this.level;
  }
}

/** Модуль предметов: покупка ключом — повтор находит купленное, как журнал предметов. */
class FakeItems {
  readonly bought = new Map<string, PurchasedItem>();
  failWith: Error | null = null;

  async buy(_accountId: string, key: string, purchase: PurchasedItem): Promise<{ item: { itemId: string }; duplicate: boolean }> {
    if (this.failWith !== null) throw this.failWith;
    const duplicate = this.bought.has(key);
    if (!duplicate) this.bought.set(key, purchase);
    return { item: { itemId: `item-${key}` }, duplicate };
  }
}

function counter(start = 1): () => number {
  let next = start;
  return () => next++;
}

function setup(level = 1) {
  const repository = new MemoryShowcase();
  repository.level = level;
  const items = new FakeItems();
  const service = new ShowcaseService(repository, items as unknown as ItemsService, counter());
  return { repository, items, service };
}

describe("витрина в числах", () => {
  it("редкость места открывается уровнем, до него — запасная; цены — целые и больше нуля; слотов хватает на все места", () => {
    expect(SHOWCASE_OFFERS.map((offer) => offerFor(offer, 1)?.rarity)).toEqual(["rare", "rare", "rare", "epic"]);
    expect(SHOWCASE_OFFERS.map((offer) => offerFor(offer, 10)?.rarity)).toEqual(["rare", "rare", "epic", "legendary"]);
    for (const offer of SHOWCASE_OFFERS) {
      for (const placed of [{ rarity: offer.rarity, gems: offer.gems }, offer.fallback]) {
        if (placed === null) continue;
        expect(Number.isInteger(placed.gems) && placed.gems > 0, placed.rarity).toBe(true);
        expect(RARITY_RULES[placed.rarity]).toBeDefined();
      }
    }
    // мифическую витрина не продаёт: её нет и в добыче (Р25)
    expect(SHOWCASE_OFFERS.some((offer) => offer.rarity === "mythic" || offer.fallback?.rarity === "mythic")).toBe(false);
    expect(SHOWCASE_OFFERS.length).toBeLessThanOrEqual(ITEM_SLOTS.length);
  });

  it("уровень предмета — как у добычи первой минуты: от уровня аккаунта и не выше его потолка", () => {
    expect(showcaseLevel(1)).toBe(1);
    expect(showcaseLevel(10)).toBe(6);
    for (const level of [1, 5, 20, 60, 100]) {
      expect(showcaseLevel(level)).toBeLessThanOrEqual(Math.min(levelCap(level), MAX_ITEM_LEVEL));
      expect(showcaseLevel(level)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("витрина суток", () => {
  it("первое открытие выставляет предметы: слоты не повторяются, свойства брошены зерном предмета, цена — из плана", async () => {
    const { service, repository } = setup(10);
    const view = await service.view(ME, NOON);
    expect(view.offers.map((offer) => offer.rarity)).toEqual(["rare", "rare", "epic", "legendary"]);
    expect(view.offers.map((offer) => offer.gems)).toEqual(SHOWCASE_OFFERS.map((offer) => offer.gems));
    expect(new Set(view.offers.map((offer) => offer.slot)).size).toBe(view.offers.length);
    expect(view.offers.every((offer) => offer.level === showcaseLevel(10) && !offer.sold)).toBe(true);

    for (const row of repository.rows) {
      expect(row.rolls).toEqual(rollItem(seededRandom(row.seed), row.slot, row.rarity));
      expect(row.gameDay).toBe("2026-09-30");
    }
    // свойства посчитаны сервером — как у предмета в арсенале
    expect(view.offers[3]?.extras).toHaveLength(RARITY_RULES.legendary.extras);
    expect(view.offers[3]?.power).toBeGreaterThan(view.offers[0]?.power ?? 0);
  });

  it("в пределах суток витрина та же — и после повышения уровня; новые сутки — новые предметы", async () => {
    const { service, repository } = setup(1);
    const first = await service.view(ME, NOON);
    repository.level = 30;
    const again = await service.view(ME, new Date(NOON.getTime() + 5 * HOUR));
    expect(again).toEqual(first);
    expect(repository.fills).toBe(1);

    const tomorrow = await service.view(ME, TOMORROW);
    expect(tomorrow.offers.map((offer) => offer.offerId)).not.toEqual(first.offers.map((offer) => offer.offerId));
    expect(tomorrow.offers.map((offer) => offer.rarity)).toEqual(["rare", "rare", "epic", "legendary"]);
  });

  it("у новичка дорогие места заняты запасной редкостью — силу не купить раньше, чем научился играть", async () => {
    const { service } = setup(1);
    expect((await service.view(ME, NOON)).offers.map((offer) => [offer.rarity, offer.gems])).toEqual([
      ["rare", 40],
      ["rare", 40],
      ["rare", 40],
      ["epic", 120],
    ]);
  });
});

describe("покупка с витрины", () => {
  it("покупается ровно показанное: тот же предмет и цена, ключом предложения; после — «куплено»", async () => {
    const { service, items } = setup(10);
    const offer = (await service.view(ME, NOON)).offers[3];
    if (offer === undefined) throw new Error("витрина пуста");
    const result = await service.buy(ME, offer.offerId, NOON);

    const key = `showcase:${offer.offerId}`;
    const purchase = items.bought.get(key);
    expect(purchase?.price).toEqual([{ resource: "gems", amount: 300 }]);
    expect(purchase?.shape).toMatchObject({ slot: offer.slot, rarity: "legendary", level: offer.level, source: key });
    expect(result.item).toEqual({ itemId: `item-${key}` });
    expect(result.view.offers[3]).toMatchObject({ offerId: offer.offerId, sold: true });
    expect(result.view.offers.filter((candidate) => candidate.sold)).toHaveLength(1);
  });

  it("второй раз не купить: проданное — отказ, а не вторая покупка", async () => {
    const { service, items } = setup();
    const offer = (await service.view(ME, NOON)).offers[0];
    if (offer === undefined) throw new Error("витрина пуста");
    await service.buy(ME, offer.offerId, NOON);
    await expect(service.buy(ME, offer.offerId, NOON)).rejects.toBeInstanceOf(ShowcaseSoldError);
    expect(items.bought.size).toBe(1);
  });

  it("обрыв после покупки, до отметки: повтор находит купленное и отмечает, не покупая второй раз", async () => {
    const { service, items, repository } = setup();
    const offer = (await service.view(ME, NOON)).offers[0];
    if (offer === undefined) throw new Error("витрина пуста");
    // предмет уже выдан тем же ключом, отметка не дошла
    await items.buy(ME, `showcase:${offer.offerId}`, { shape: { slot: offer.slot, rarity: offer.rarity, level: offer.level, seed: 0, rolls: { main: { stat: "damage", roll: 1 }, extras: [] }, source: "x" }, price: [] });
    await service.buy(ME, offer.offerId, NOON);
    expect(items.bought.size).toBe(1);
    expect(repository.rows.find((row) => row.offerId === offer.offerId)).toMatchObject({ itemId: `item-showcase:${offer.offerId}` });
  });

  it("вчерашнее предложение не купить; чужое и выдуманное — как несуществующее", async () => {
    const { service } = setup();
    const offer = (await service.view(ME, NOON)).offers[0];
    if (offer === undefined) throw new Error("витрина пуста");
    await expect(service.buy(ME, offer.offerId, TOMORROW)).rejects.toBeInstanceOf(ShowcaseExpiredError);
    await expect(service.buy("00000000-0000-4000-8000-0000000005c2", offer.offerId, NOON)).rejects.toBeInstanceOf(ShowcaseOfferNotFoundError);
    await expect(service.buy(ME, "00000000-0000-4000-8000-000000000000", NOON)).rejects.toBeInstanceOf(ShowcaseOfferNotFoundError);
  });

  it("не хватило самоцветов или места в инвентаре — предложение остаётся на витрине", async () => {
    const { service, items, repository } = setup();
    const offer = (await service.view(ME, NOON)).offers[0];
    if (offer === undefined) throw new Error("витрина пуста");
    items.failWith = new InsufficientFundsError("gems", 40, 3);
    await expect(service.buy(ME, offer.offerId, NOON)).rejects.toBeInstanceOf(InsufficientFundsError);
    items.failWith = new ItemRuleError("inventory_full", "Инвентарь полон");
    await expect(service.buy(ME, offer.offerId, NOON)).rejects.toMatchObject({ code: "inventory_full" });
    expect(repository.rows.every((row) => row.soldAt === null)).toBe(true);
  });

  it("вид предложения не раскрывает зерна и бросков — только посчитанные значения", () => {
    const row: ShowcaseRow = {
      offerId: "o",
      accountId: ME,
      gameDay: "2026-09-30",
      position: 0,
      slot: "weapon",
      rarity: "rare",
      level: 3,
      seed: 42,
      rolls: rollItem(seededRandom(42), "weapon", "rare"),
      priceGems: 40,
      soldAt: null,
      itemId: null,
    };
    const view = offerView(row);
    expect(Object.keys(view).sort()).toEqual(["extras", "gems", "level", "main", "offerId", "power", "rarity", "slot", "sold"]);
  });
});

describe("витрина по HTTP", () => {
  let app: NestFastifyApplication | null = null;
  const unavailableRedis = { eval: async () => Promise.reject(new Error("connection refused")) } as unknown as Redis;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("без токена — 401; витрина — 200; кривой id — 400; чужой — 404 с кодом", async () => {
    const ctx = setup();
    @Module({
      controllers: [ShopController],
      providers: [
        { provide: APP_CONFIG, useValue: loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv) },
        { provide: REDIS, useValue: unavailableRedis },
        { provide: ShopService, useValue: {} },
        { provide: ShowcaseService, useValue: ctx.service },
        RateLimiter,
        AuthGuard,
      ],
    })
    class TestModule {}
    app = await createHttpApp(TestModule, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const token = await signAccessToken({ accountId: ME, platform: "telegram", platformUserId: "1" }, secretKey(AUTH_ENV.JWT_ACCESS_SECRET), 900, Date.now());
    const headers = { authorization: `Bearer ${token}` };

    expect((await app.inject({ method: "GET", url: "/api/v1/shop/showcase" })).statusCode).toBe(401);
    const view = await app.inject({ method: "GET", url: "/api/v1/shop/showcase", headers });
    expect(view.statusCode).toBe(200);
    expect(view.json<{ data: { offers: unknown[] } }>().data.offers).toHaveLength(4);

    expect((await app.inject({ method: "POST", url: "/api/v1/shop/showcase/not-a-uuid/buy", headers })).statusCode).toBe(400);
    const missing = await app.inject({ method: "POST", url: "/api/v1/shop/showcase/00000000-0000-4000-8000-000000000000/buy", headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe("showcase_offer_not_found");
  });
});
