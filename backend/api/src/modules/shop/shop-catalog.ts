import type { PaymentMethod, Product } from "@bh/fx";
import { z } from "zod";
import type { WalletResource } from "../wallet/wallet-types.js";

/**
 * Каталог магазина (docs/35-stage4-plan.md §3.6, WP10). Меняется здесь, в
 * карте конфигурации — docs/30-configuration-map.md.
 *
 * **Граница с гачей (Р11) держится схемой, а не ревью.** У товара за деньги
 * есть только состав — сколько чего ляжет на счёт, — и он виден до оплаты.
 * Поля для случайного содержимого в схеме нет вовсе, а лишнее поле схема не
 * пропустит: товар «сундук со случайным предметом» в этот каталог не
 * записать.
 *
 * **Рабочие числа (Р31)** — цены и составы ставит команда (О1). Опора: звезда
 * игроку — 1,72 ₽ (Р37), буст за самоцветы — 4–6, самоцветы за уровень — 10
 * каждый пятый; крупный набор выгоднее мелкого, стартовый — самый выгодный и
 * один на аккаунт.
 */

/** Что продаётся — ресурсы кошелька ровно в этих количествах. */
export const SHOP_RESOURCES = ["coins", "gems", "shard_common", "shard_uncommon"] as const satisfies readonly WalletResource[];
export type ShopResource = (typeof SHOP_RESOURCES)[number];

export const SHOP_KINDS = ["gems", "bundle", "starter"] as const;
export type ShopKind = (typeof SHOP_KINDS)[number];

/** Способы оплаты игры (WP9 → WP10). Пока один: в Mini App цифровое продаётся только за звёзды. */
export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  { id: "telegram_stars", platform: "telegram", provider: "telegram_stars", currency: "XTR", minAmount: "1", maxAmount: "10000", fee: { percent: "0", placement: "inside" }, order: 1 },
];

/** Название в окне оплаты Telegram — до 32 знаков, с запасом на пометку тестовой оплаты. */
export const TITLE_MAX = 25;

const contentsSchema = z
  .object({
    coins: z.number().int().positive().optional(),
    gems: z.number().int().positive().optional(),
    shard_common: z.number().int().positive().optional(),
    shard_uncommon: z.number().int().positive().optional(),
  })
  .strict()
  .refine((contents) => Object.keys(contents).length > 0, "пустой состав");

export const shopSkuSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
    kind: z.enum(SHOP_KINDS),
    /** что ляжет на счёт — ровно это, без случайности */
    contents: contentsSchema,
    /** название и описание в окне оплаты площадки; у игрока в магазине — текст из словаря по id */
    title: z.string().min(1).max(TITLE_MAX),
    description: z.string().min(1).max(160),
    /** базовая цена в рублях — для отчёта и будущих способов оплаты; ручная цена в звёздах побеждает пересчёт */
    baseRub: z.string().regex(/^\d+(\.\d{1,2})?$/),
    stars: z.number().int().min(1).max(10_000),
    /** один на аккаунт */
    once: z.boolean(),
    /** порядок на витрине */
    sort: z.number().int(),
  })
  .strict();

export type ShopSku = z.infer<typeof shopSkuSchema>;

export const SHOP_SKUS: readonly ShopSku[] = [
  {
    id: "starter",
    kind: "starter",
    contents: { coins: 3_000, gems: 60, shard_common: 20 },
    title: "Стартовый набор",
    description: "3 000 монет, 60 самоцветов и 20 обычных осколков — один раз на аккаунт.",
    baseRub: "86",
    stars: 50,
    once: true,
    sort: 10,
  },
  {
    id: "gems_60",
    kind: "gems",
    contents: { gems: 60 },
    title: "60 самоцветов",
    description: "60 самоцветов на счёт — на бусты «Фора» и «Чутьё» и не только.",
    baseRub: "86",
    stars: 50,
    once: false,
    sort: 20,
  },
  {
    id: "gems_330",
    kind: "gems",
    contents: { gems: 330 },
    title: "330 самоцветов",
    description: "330 самоцветов на счёт — на десятую часть выгоднее малого набора.",
    baseRub: "430",
    stars: 250,
    once: false,
    sort: 30,
  },
  {
    id: "gems_700",
    kind: "gems",
    contents: { gems: 700 },
    title: "700 самоцветов",
    description: "700 самоцветов на счёт — на шестую часть выгоднее малого набора.",
    baseRub: "860",
    stars: 500,
    once: false,
    sort: 40,
  },
  {
    id: "upgrade_kit",
    kind: "bundle",
    contents: { coins: 8_000, shard_common: 40, shard_uncommon: 10 },
    title: "Набор кузнеца",
    description: "8 000 монет, 40 обычных и 10 добротных осколков — на улучшение снаряжения.",
    baseRub: "258",
    stars: 150,
    once: false,
    sort: 50,
  },
];

export function skuById(id: string): ShopSku | undefined {
  return SHOP_SKUS.find((sku) => sku.id === id);
}

/** Товар для слоя цен WP9: базовая цена и ручная — в звёздах. */
export function priceProduct(sku: ShopSku): Product {
  return { id: sku.id, base: { currency: "RUB", amount: sku.baseRub }, manual: { telegram_stars: String(sku.stars) } };
}

/** Состав как пары «ресурс — сколько», в порядке ресурсов. */
export function contentsOf(sku: ShopSku): { resource: ShopResource; amount: number }[] {
  return SHOP_RESOURCES.flatMap((resource) => {
    const amount = sku.contents[resource];
    return amount === undefined ? [] : [{ resource, amount }];
  });
}
