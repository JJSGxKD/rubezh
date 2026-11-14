import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../src/common/domain-error.js";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import { APPEARANCES, appearanceById } from "../src/modules/appearance/appearance-catalog.js";
import { heldAppearances, type AppearanceState } from "../src/modules/appearance/appearance-rules.js";
import type { AppearanceGrantInput, AppearanceGrantsRepository } from "../src/modules/appearance/appearance-grants.repository.js";
import { PaymentConfirmation } from "../src/modules/payments/payment-confirmation.js";
import { PaymentRefunds } from "../src/modules/payments/payment-refunds.js";
import { PaymentsHooks } from "../src/modules/payments/payments-hooks.js";
import { PaymentsQueue } from "../src/modules/payments/payments-queue.js";
import { PaymentsService } from "../src/modules/payments/payments.service.js";
import { PurchaseFulfillment, UndeliverableError } from "../src/modules/payments/purchase-fulfillment.js";
import { PurchaseRevocation } from "../src/modules/payments/purchase-revocation.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { RunsHooks } from "../src/modules/runs/runs-hooks.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import type { SettingsReader } from "../src/modules/settings/settings.service.js";
import type { ItemsService } from "../src/modules/items/items.service.js";
import { KEEPER_SET_HOURS, KEEPER_SET_SKU, KeeperSet, keeperSetWindow, type FirstWinRepository } from "../src/modules/shop/keeper-set.js";
import { SHOP_SKUS, contentsOf, shopSkuSchema, skuById, type ShopSku } from "../src/modules/shop/shop-catalog.js";
import type { ShopChoice } from "../src/modules/shop/shop-choice.js";
import { NO_SHOP_OVERRIDES, ShopOverrides, applyOverride, skuOverrideSchema } from "../src/modules/shop/shop-overrides.js";
import { ShopPromoService } from "../src/modules/shop/shop-promo.service.js";
import { ShopService } from "../src/modules/shop/shop.service.js";
import type { GrantInput, GrantResult, WalletService } from "../src/modules/wallet/wallet.service.js";
import type { RevokeInput, RevokeOutcome } from "../src/modules/wallet/wallet.repository.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { FakeStarsApi, starsProviders } from "./helpers/fake-stars-api.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryPurchasesRepository } from "./helpers/memory-purchases.js";
import { MemoryRestrictionsRepository, restrictionsGate } from "./helpers/memory-restrictions.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";
import { MemoryRunsRepository } from "./helpers/memory-runs.js";
import { MemoryShopPromoRepository } from "./helpers/memory-shop-promos.js";
import { switchesOf } from "./helpers/notify-targets.js";

/**
 * «Набор хранителя» (docs/35-stage4-plan.md Р155, tasks/T-0245): окно в 48 часов после первой
 * победы над Рубежом, каталог, выдача окраса и самоцветов, отзыв при возврате. Без базы — на
 * памяти; то же на живых Postgres и Redis — `keeper-set.integration.test.ts`.
 */

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 14, 9);
const WIN = new Date(NOW - 5 * HOUR);

function config(): AppConfig {
  return loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, TELEGRAM_BOT_UPDATES: "polling", PAYMENTS_ENABLED: "true" } as NodeJS.ProcessEnv);
}

function player(platformUserId = "555000222"): AccountRef {
  return { accountId: randomUUID(), platform: "telegram", platformUserId };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error("ожидался отказ");
}

class FakeWallet {
  readonly grants: GrantInput[] = [];
  private readonly keys = new Set<string>();

  async grant(input: GrantInput): Promise<GrantResult> {
    const duplicate = this.keys.has(input.idempotencyKey);
    if (!duplicate) {
      this.keys.add(input.idempotencyKey);
      this.grants.push(input);
    }
    return { credited: input.amount, balance: 0, duplicate };
  }

  async revokeUpTo(input: RevokeInput): Promise<RevokeOutcome> {
    return input.resource === "gems" ? { status: "revoked", revoked: 330, granted: 330, balance: 0 } : { status: "nothing", granted: 0 };
  }
}

/** Выдачи обликов в памяти: ключ `(аккаунт, облик)`, повтор не меняет строку, как `ON CONFLICT DO NOTHING`. */
class MemoryGrants implements AppearanceGrantsRepository {
  readonly rows: AppearanceGrantInput[] = [];
  failNext = false;

  async held(accountIds: readonly string[]): Promise<Map<string, Set<string>>> {
    const result = new Map<string, Set<string>>();
    for (const row of this.rows) {
      if (!accountIds.includes(row.accountId)) continue;
      const set = result.get(row.accountId) ?? new Set<string>();
      set.add(row.appearanceId);
      result.set(row.accountId, set);
    }
    return result;
  }

  async grant(input: AppearanceGrantInput): Promise<boolean> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("база недоступна");
    }
    if (this.rows.some((row) => row.accountId === input.accountId && row.appearanceId === input.appearanceId)) return false;
    this.rows.push({ ...input });
    return true;
  }

  async revokeByPurchase(purchaseId: string): Promise<string[]> {
    const removed = this.rows.filter((row) => row.purchaseId === purchaseId).map((row) => row.appearanceId);
    for (let index = this.rows.length - 1; index >= 0; index--) if (this.rows[index]?.purchaseId === purchaseId) this.rows.splice(index, 1);
    return removed;
  }
}

/** Первая победа аккаунта — то, что в базе считается по таблице забегов. */
class FirstWins implements FirstWinRepository {
  readonly wins = new Map<string, Date>();
  failWith: Error | null = null;
  calls = 0;

  async firstWinAt(accountId: string): Promise<Date | null> {
    this.calls++;
    if (this.failWith !== null) throw this.failWith;
    return this.wins.get(accountId) ?? null;
  }
}

function setup(overrides: ShopOverrides = new ShopOverrides(NO_SHOP_OVERRIDES)) {
  const settings = config();
  const purchases = new MemoryPurchasesRepository();
  const api = new FakeStarsApi();
  const providers = starsProviders(api);
  const payments = new PaymentsService(settings, purchases, new MemoryRunsRepository(), providers, switchesOf(settings));
  const fulfillment = new PurchaseFulfillment();
  const wallet = new FakeWallet();
  const equipped = { count: 0 };
  const items = { inventory: async () => ({ equipped: Object.fromEntries(Array.from({ length: equipped.count }, (_, index) => [`slot${String(index)}`, "item"])) }) };
  const reader: SettingsReader = { get: (setting) => (setting.key === SETTINGS.shopTributeUrl.key ? setting.schema.parse("") : setting.fallback), onChange: () => undefined };
  const promoRows = new MemoryShopPromoRepository();
  const promos = new ShopPromoService(promoRows, new RolesService(settings, new MemoryRolesRepository(), new MemoryAccountRepository()));
  const revocation = new PurchaseRevocation();
  const restrictions = new MemoryRestrictionsRepository();
  const choice = { counts: async () => new Map<string, number>() } as unknown as ShopChoice;
  const firstWins = new FirstWins();
  const grants = new MemoryGrants();
  const shop = new ShopService(
    payments,
    fulfillment,
    wallet as unknown as WalletService,
    items as unknown as ItemsService,
    promos,
    reader,
    revocation,
    restrictionsGate(restrictions),
    choice,
    overrides,
    new KeeperSet(firstWins),
    grants,
  );
  shop.onModuleInit();
  const confirmation = new PaymentConfirmation(settings, purchases, providers, switchesOf(settings), new PaymentsHooks(), revocation);
  const queue = new PaymentsQueue(settings, confirmation, new PaymentRefunds(purchases, providers, new PurchaseRevocation()), new RunsHooks(), providers, fulfillment, purchases);
  return { purchases, api, shop, wallet, grants, firstWins, promoRows, equipped, confirmation, queue, revocation, restrictions };
}

/** Площадка подтвердила оплату — задание очереди, как его выполнил бы воркер. */
async function pay(ctx: ReturnType<typeof setup>, purchaseId: string, payer: string, chargeId = `charge-${purchaseId}`): Promise<void> {
  const row = await ctx.purchases.byId(purchaseId);
  if (row === null) throw new Error("нет покупки");
  ctx.purchases.owners.set(row.accountId, payer);
  await ctx.queue.process({ data: { kind: "confirm", payment: { platform: "telegram", chargeId, payload: purchaseId, payerId: payer, currency: "XTR", totalAmount: row.chargedStars } } });
}

describe("окно набора хранителя", () => {
  const win = new Date(Date.UTC(2026, 10, 10, 12));

  it("48 часов — число из решения владельца, товар — keeper_set", () => {
    expect(KEEPER_SET_HOURS).toBe(48);
    expect(KEEPER_SET_SKU).toBe("keeper_set");
  });

  it("победы нет — окно закрыто, срока нет", () => {
    expect(keeperSetWindow(null, win)).toEqual({ open: false, until: null });
  });

  it("в момент победы и через 47 ч 59 мин — открыто, срок — победа + 48 часов", () => {
    const until = new Date(win.getTime() + 48 * HOUR);
    expect(keeperSetWindow(win, win)).toEqual({ open: true, until });
    expect(keeperSetWindow(win, new Date(win.getTime() + 47 * HOUR + 59 * 60_000))).toEqual({ open: true, until });
    expect(keeperSetWindow(win, new Date(until.getTime() - 1))).toEqual({ open: true, until });
  });

  it("ровно через 48 часов и позже — закрыто", () => {
    const until = new Date(win.getTime() + 48 * HOUR);
    expect(keeperSetWindow(win, until).open).toBe(false);
    expect(keeperSetWindow(win, new Date(win.getTime() + 49 * HOUR)).open).toBe(false);
    expect(keeperSetWindow(win, new Date(win.getTime() + 400 * 24 * HOUR)).open).toBe(false);
  });

  it("часы реплики отстали от записи победы — окно не закрывается из-за сдвига", () => {
    expect(keeperSetWindow(win, new Date(win.getTime() - 60_000)).open).toBe(true);
  });

  it("битая дата победы (строка базы) — окно закрыто, а не открыто навсегда", () => {
    expect(keeperSetWindow(new Date(Number.NaN), win)).toEqual({ open: false, until: null });
    expect(keeperSetWindow(win, new Date(Number.NaN)).open).toBe(false);
  });

  it("вторая победа окно не продлевает: берётся самая ранняя", async () => {
    const wins = new FirstWins();
    const me = player();
    wins.wins.set(me.accountId, win);
    const keeper = new KeeperSet(wins);
    const first = await keeper.window(me.accountId, new Date(win.getTime() + 10 * HOUR));
    // Репозиторий отдаёт одно значение — минимум; вторая победа его не двигает.
    expect(first.until).toEqual(new Date(win.getTime() + 48 * HOUR));
    expect((await keeper.window(me.accountId, new Date(win.getTime() + 50 * HOUR))).open).toBe(false);
  });
});

describe("каталог: набор и облик «рассвет»", () => {
  it("набор — пакет 330 самоцветов с окрасом по цене пакета: 250 звёзд, разовый, `bundle`", () => {
    const set = skuById("keeper_set");
    const pack = skuById("gems_330");
    expect(set).toMatchObject({ id: "keeper_set", kind: "bundle", once: true, stars: 250, contents: { gems: 330, appearance: "dawn" }, title: "Набор хранителя" });
    expect(set?.stars).toBe(pack?.stars);
    expect(set?.contents.gems).toBe(pack?.contents.gems);
    expect(set?.baseRub).toBe(pack?.baseRub);
    expect(set?.badge).toBeUndefined();
  });

  it("набор идёт первым на витрине; состав в тексте счёта называет и самоцветы, и окрас", () => {
    const first = [...SHOP_SKUS].sort((a, b) => a.sort - b.sort)[0];
    expect(first?.id).toBe("keeper_set");
    expect(skuById("keeper_set")?.description).toContain("330 самоцветов");
    expect(skuById("keeper_set")?.description).toContain("Хранитель · рассвет");
  });

  it("облик dawn: архетип keeper, редкость rare, источник — покупка набора", () => {
    expect(appearanceById("dawn")).toEqual({ id: "dawn", archetype: "keeper", rarity: "rare", source: { kind: "purchase", sku: "keeper_set" } });
    expect(APPEARANCES.map((def) => def.id)).toContain("dawn");
  });

  it("облик и товар ссылаются друг на друга: у каждого товара с окрасом окрас продаётся именно им, у каждого купленного облика есть товар", () => {
    for (const sku of SHOP_SKUS) {
      const appearance = sku.contents.appearance;
      if (appearance === undefined) continue;
      expect(appearanceById(appearance)?.source, sku.id).toEqual({ kind: "purchase", sku: sku.id });
    }
    for (const def of APPEARANCES) {
      if (def.source.kind !== "purchase") continue;
      expect(skuById(def.source.sku)?.contents.appearance, def.id).toBe(def.id);
    }
  });

  it("схема не пропустит окрас, которого нет в каталоге обликов, и лишнее поле состава", () => {
    const set = skuById("keeper_set") as ShopSku;
    expect(shopSkuSchema.safeParse(set).success).toBe(true);
    expect(shopSkuSchema.safeParse({ ...set, contents: { gems: 330, appearance: "no_such" } }).success).toBe(false);
    expect(shopSkuSchema.safeParse({ ...set, contents: { gems: 330, appearance: 7 } }).success).toBe(false);
    expect(shopSkuSchema.safeParse({ ...set, contents: { gems: 330, appearance: "dawn", coins: 10 } }).success).toBe(false);
    expect(shopSkuSchema.safeParse({ ...set, contents: { appearance: "dawn" } }).success).toBe(false);
  });

  it("состав в ресурсах кошелька — только самоцветы: окрас — отдельное поле, а не ресурс", () => {
    const set = skuById("keeper_set") as ShopSku;
    expect(contentsOf(set)).toEqual([{ resource: "gems", amount: 330 }]);
  });

  it("правка команды не может приписать товару другой окрас; число самоцветов правится, а окрас и тексты остаются", () => {
    const set = skuById("keeper_set") as ShopSku;
    expect(skuOverrideSchema.safeParse({ contents: { gems: 330, appearance: "knyaz" } }).success).toBe(false);
    expect(skuOverrideSchema.safeParse({ contents: { gems: 360 } }).success).toBe(true);
    const edited = applyOverride(set, { contents: { gems: 360 } });
    expect(edited?.contents).toEqual({ gems: 360, appearance: "dawn" });
    expect(edited?.title).toBe("Набор хранителя");
    expect(edited?.description).toContain("360 самоцветов");
    expect(edited?.description).toContain("окрас");
  });
});

describe("владение окрасом по выдачам", () => {
  const NOBODY: AppearanceState = { level: 1, vipActive: false, bestSeasonPlace: null, doneAchievements: new Set<string>(), weeklyTopClaimed: false, grants: new Set<string>() };

  it("есть выдача dawn — держится; нет — нет", () => {
    expect(heldAppearances({ ...NOBODY, grants: new Set(["dawn"]) }).has("dawn")).toBe(true);
    expect(heldAppearances(NOBODY).has("dawn")).toBe(false);
  });

  it("чужая строка выдачи облика не по покупке ничего не даёт: Князь — по VIP, Навий страж — по сезону", () => {
    const held = heldAppearances({ ...NOBODY, grants: new Set(["knyaz", "navi", "vityaz"]) });
    expect([...held].sort()).toEqual(["keeper"]);
  });
});

describe("витрина и заказ набора", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  const at = (offsetMs: number) => new Date(NOW + offsetMs);

  it("победы нет — набора на витрине нет, а заказ — 404 как у несуществующего товара", async () => {
    const me = player();
    const view = await ctx.shop.view(me, at(0));
    expect(view.items.map((item) => item.sku)).not.toContain("keeper_set");
    expect(await codeOf(ctx.shop.order(me, "keeper_set", at(0)))).toBe(await codeOf(ctx.shop.order(me, "chest_legendary", at(0))));
    expect(await codeOf(ctx.shop.order(me, "keeper_set", at(0)))).toBe("shop_sku_not_found");
    expect(ctx.purchases.rows.size).toBe(0);
  });

  it("после победы набор — первая позиция витрины со сроком, окрасом и составом; цена без зачёркнутой", async () => {
    const me = player();
    ctx.firstWins.wins.set(me.accountId, WIN);

    const view = await ctx.shop.view(me, at(0));

    expect(view.items[0]).toEqual({
      sku: "keeper_set",
      kind: "bundle",
      contents: [{ resource: "gems", amount: 330 }],
      stars: 250,
      fullStars: null,
      promo: null,
      chargedStars: 250,
      once: true,
      owned: false,
      badge: null,
      valuePct: null,
      appearance: "dawn",
      until: new Date(WIN.getTime() + 48 * HOUR),
    });
    // Остальные позиции срока не несут и окраса не обещают.
    for (const item of view.items.slice(1)) expect(item).toMatchObject({ until: null, appearance: null });
  });

  it("47 ч 59 мин — продаётся; 48 ч — позиции нет и заказ 404; другому игроку набора нет и в окне", async () => {
    const me = player();
    ctx.firstWins.wins.set(me.accountId, WIN);
    const last = new Date(WIN.getTime() + 47 * HOUR + 59 * 60_000);
    expect((await ctx.shop.view(me, last)).items.map((item) => item.sku)).toContain("keeper_set");
    expect(await ctx.shop.order(me, "keeper_set", last)).toMatchObject({ sku: "keeper_set", status: "pending", priceStars: 250 });

    const closed = new Date(WIN.getTime() + 48 * HOUR);
    expect((await ctx.shop.view(me, closed)).items.map((item) => item.sku)).not.toContain("keeper_set");
    expect(await codeOf(ctx.shop.order(me, "keeper_set", closed))).toBe("shop_sku_not_found");
    expect(await codeOf(ctx.shop.order(player(), "keeper_set", last))).toBe("shop_sku_not_found");
  });

  it("счёт — по цене пакета, с составом в окне оплаты; повторный заказ — тот же счёт, а не второй", async () => {
    const me = player();
    ctx.firstWins.wins.set(me.accountId, WIN);

    const first = await ctx.shop.order(me, "keeper_set", at(0));
    const second = await ctx.shop.order(me, "keeper_set", at(0));

    expect(first).toMatchObject({ sku: "keeper_set", status: "pending", priceStars: 250, chargedStars: 250, mode: "live" });
    expect(second.purchaseId).toBe(first.purchaseId);
    expect(ctx.api.sent.at(-1)).toMatchObject({ stars: 250, title: "Набор хранителя" });
    expect(ctx.api.sent.at(-1)?.description).toContain("Хранитель · рассвет");
    expect(ctx.purchases.rows.size).toBe(1);
  });

  it("акция команды на набор не действует: зачёркнутой цены у набора нет ни в витрине, ни в счёте", async () => {
    const me = player();
    ctx.firstWins.wins.set(me.accountId, WIN);
    ctx.promoRows.seed({ sku: "keeper_set", percent: 50, startsAt: at(-HOUR), endsAt: at(HOUR) });

    const item = (await ctx.shop.view(me, at(0))).items.find((candidate) => candidate.sku === "keeper_set");

    expect(item).toMatchObject({ stars: 250, fullStars: null, promo: null });
    expect(await ctx.shop.order(me, "keeper_set", at(0))).toMatchObject({ priceStars: 250, chargedStars: 250 });
  });

  it("«Рекомендуем» набор не занимает: он живёт своей карточкой, а подбор остаётся прежним", async () => {
    const me = player();
    ctx.firstWins.wins.set(me.accountId, WIN);
    ctx.equipped.count = 3;
    const starter = await ctx.shop.order(me, "starter", at(0));
    await pay(ctx, starter.purchaseId, me.platformUserId);

    const view = await ctx.shop.view(me, at(0));

    expect(view.recommended).not.toBe("keeper_set");
  });

  it("набор не участвует в «Лучшей цене» и выгоде самоцветов", async () => {
    const me = player();
    ctx.firstWins.wins.set(me.accountId, WIN);
    const without = await ctx.shop.view(player(), at(0));

    const view = await ctx.shop.view(me, at(0));

    expect(view.items.filter((item) => item.sku !== "keeper_set").map((item) => [item.sku, item.badge, item.valuePct])).toEqual(without.items.map((item) => [item.sku, item.badge, item.valuePct]));
  });

  it("окно не прочиталось: витрина отвечает без набора, остальное на месте; заказ набора не выставляется", async () => {
    const me = player();
    ctx.firstWins.wins.set(me.accountId, WIN);
    ctx.firstWins.failWith = new Error("база недоступна");

    const view = await ctx.shop.view(me, at(0));

    expect(view.items.map((item) => item.sku)).toEqual(["starter", "gems_60", "gems_330", "gems_700"]);
    await expect(ctx.shop.order(me, "keeper_set", at(0))).rejects.toThrow("база недоступна");
    expect(ctx.purchases.rows.size).toBe(0);
    // Обычный товар от окна не зависит и к базе забегов не обращается.
    ctx.firstWins.calls = 0;
    expect(await ctx.shop.order(me, "gems_60", at(0))).toMatchObject({ status: "pending" });
    expect(ctx.firstWins.calls).toBe(0);
  });

  it("ограничение «Покупки» отвечает раньше окна: закрытому аккаунту набор отказывает так же, как любой товар", async () => {
    const me = player();
    ctx.firstWins.wins.set(me.accountId, WIN);
    ctx.restrictions.restrict(me.accountId, "purchases");

    expect(await codeOf(ctx.shop.order(me, "keeper_set", at(0)))).toBe("account_restricted");
    expect(await codeOf(ctx.shop.order(me, "keeper_set", new Date(WIN.getTime() + 60 * HOUR)))).toBe("account_restricted");
    expect(ctx.purchases.rows.size).toBe(0);
  });
});

describe("выдача и отзыв набора", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  const at = (offsetMs: number) => new Date(NOW + offsetMs);

  /** Игрок с победой, заказавший набор. */
  async function buyer() {
    const me = player();
    ctx.firstWins.wins.set(me.accountId, WIN);
    const invoice = await ctx.shop.order(me, "keeper_set", at(0));
    return { me, invoice };
  }

  it("оплата кладёт 330 самоцветов ключом покупки и выдаёт окрас строкой с источником «покупка»; покупка помечена выданной", async () => {
    const { me, invoice } = await buyer();

    await pay(ctx, invoice.purchaseId, me.platformUserId);

    expect(ctx.wallet.grants).toEqual([
      { accountId: me.accountId, resource: "gems", amount: 330, reason: "purchase", source: "shop:keeper_set", idempotencyKey: `purchase:${invoice.purchaseId}:gems` },
    ]);
    expect(ctx.grants.rows).toHaveLength(1);
    expect(ctx.grants.rows[0]).toMatchObject({ accountId: me.accountId, appearanceId: "dawn", source: "purchase", purchaseId: invoice.purchaseId });
    expect((await ctx.purchases.byId(invoice.purchaseId))?.fulfilledAt).not.toBeNull();
  });

  it("повтор подтверждения и повтор задания ничего не удваивают: ни самоцветов, ни строки окраса", async () => {
    const { me, invoice } = await buyer();

    await pay(ctx, invoice.purchaseId, me.platformUserId, "charge-1");
    await pay(ctx, invoice.purchaseId, me.platformUserId, "charge-1");
    const stored = await ctx.purchases.byId(invoice.purchaseId);
    if (stored === null) throw new Error("покупки нет");
    await ctx.shop.fulfill(stored);
    await ctx.shop.fulfill(stored);

    expect(ctx.wallet.grants).toHaveLength(1);
    expect(ctx.grants.rows).toHaveLength(1);
  });

  it("упала выдача окраса после самоцветов — покупка не помечена выданной, повтор доводит до конца без второго начисления", async () => {
    const { me, invoice } = await buyer();
    ctx.grants.failNext = true;

    await expect(pay(ctx, invoice.purchaseId, me.platformUserId, "charge-1")).rejects.toThrow("база недоступна");
    expect((await ctx.purchases.byId(invoice.purchaseId))?.status).toBe("paid");
    expect((await ctx.purchases.byId(invoice.purchaseId))?.fulfilledAt).toBeNull();
    expect(ctx.grants.rows).toHaveLength(0);

    await pay(ctx, invoice.purchaseId, me.platformUserId, "charge-1");

    expect(ctx.wallet.grants).toHaveLength(1);
    expect(ctx.grants.rows).toHaveLength(1);
    expect((await ctx.purchases.byId(invoice.purchaseId))?.fulfilledAt).not.toBeNull();
  });

  it("купленный набор с витрины уходит; повторный заказ — «оплачено» без второго счёта; вторая оплата того же счёта — возврат", async () => {
    const { me, invoice } = await buyer();
    await pay(ctx, invoice.purchaseId, me.platformUserId, "charge-a");

    const view = await ctx.shop.view(me, at(0));
    expect(view.items.map((item) => item.sku)).not.toContain("keeper_set");
    expect(await ctx.shop.order(me, "keeper_set", at(0))).toMatchObject({ purchaseId: invoice.purchaseId, status: "paid", invoiceUrl: null });
    expect(ctx.purchases.rows.size).toBe(1);

    await pay(ctx, invoice.purchaseId, me.platformUserId, "charge-b");
    expect(ctx.wallet.grants).toHaveLength(1);
    expect(ctx.grants.rows).toHaveLength(1);
    expect(ctx.api.refunded).toContainEqual({ userId: Number(me.platformUserId), chargeId: "charge-b" });
  });

  it("счёт выставлен внутри окна, оплата пришла после его конца — выдача идёт: окно проверяется на заказе, а не на выдаче", async () => {
    const { me, invoice } = await buyer();
    // К моменту подтверждения окно закрыто: победа считается заново и «вчерашняя».
    ctx.firstWins.wins.set(me.accountId, new Date(NOW - 100 * HOUR));

    await pay(ctx, invoice.purchaseId, me.platformUserId);

    expect(ctx.wallet.grants).toHaveLength(1);
    expect(ctx.grants.rows.map((row) => row.appearanceId)).toEqual(["dawn"]);
  });

  it("окраса нет в каталоге обликов — выдать нечего: отказ без начисления самоцветов, звёзды вернёт проход довыдачи", async () => {
    const broken: ShopSku = { ...(skuById("keeper_set") as ShopSku), contents: { gems: 330, appearance: "ghost" } };
    const overrides = { sku: async (id: string) => (id === "keeper_set" ? broken : undefined), skus: async () => [broken] } as unknown as ShopOverrides;
    const local = setup(overrides);
    const me = player();
    const stored = {
      purchaseId: randomUUID(),
      accountId: me.accountId,
      product: "shop_item" as const,
      sku: "keeper_set",
      mode: "live" as const,
    };

    await expect(local.shop.fulfill(stored as never)).rejects.toBeInstanceOf(UndeliverableError);

    expect(local.wallet.grants).toEqual([]);
    expect(local.grants.rows).toEqual([]);
  });

  it("возврат: самоцветы забираются по правилам возврата и строка окраса удаляется; повтор обработки — ничего второй раз", async () => {
    const { me, invoice } = await buyer();
    await pay(ctx, invoice.purchaseId, me.platformUserId, "charge-dispute");
    const row = await ctx.purchases.byId(invoice.purchaseId);
    if (row === null) throw new Error("покупки нет");

    const first = await ctx.shop.revoke(row, at(60_000));
    const second = await ctx.shop.revoke(row, at(60_000));

    expect(first.lines).toEqual(["gems: 330 из 330", "облик dawn: снят"]);
    expect(second.lines).toEqual(["gems: 330 из 330"]);
    expect(ctx.grants.rows).toEqual([]);
  });

  it("возврат целиком по событию площадки: окраса не остаётся, а у соседа и у чужой покупки он на месте", async () => {
    const { me, invoice } = await buyer();
    await pay(ctx, invoice.purchaseId, me.platformUserId, "charge-dispute");
    const neighbour = player("555000333");
    ctx.firstWins.wins.set(neighbour.accountId, WIN);
    const other = await ctx.shop.order(neighbour, "keeper_set", at(0));
    await pay(ctx, other.purchaseId, neighbour.platformUserId, "charge-other");
    expect(ctx.grants.rows).toHaveLength(2);

    await ctx.confirmation.refunded("charge-dispute", NOW + 120_000);

    expect(ctx.grants.rows.map((row) => row.accountId)).toEqual([neighbour.accountId]);
  });

  it("возврат товара без окраса чужих выдач не трогает", async () => {
    const { me, invoice } = await buyer();
    await pay(ctx, invoice.purchaseId, me.platformUserId);
    const small = await ctx.shop.order(me, "gems_60", at(0));
    await pay(ctx, small.purchaseId, me.platformUserId, "charge-small");
    const row = await ctx.purchases.byId(small.purchaseId);
    if (row === null) throw new Error("покупки нет");

    await ctx.shop.revoke(row, at(60_000));

    expect(ctx.grants.rows.map((grant) => grant.appearanceId)).toEqual(["dawn"]);
  });
});
