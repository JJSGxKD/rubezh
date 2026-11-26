import type { Product } from "@bh/fx";
import { z } from "zod";
import { appearanceById } from "../appearance/appearance-catalog.js";
import type { WalletResource } from "../wallet/wallet-types.js";
import { KEEPER_SET_SKU } from "./keeper-set.js";

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
 * **Только самоцветы (Р2).** Монеты и осколки за звёзды не продаются и внутри
 * наборов: ими оплачивается случайное (перековка, улучшение, добыча), и набор
 * с ними за деньги покупал бы случайное через шаг. Кошелёк при покупке и так
 * начисляет только самоцветы, а схема состава держит то же правило — расхождение
 * каталога и кошелька ловит тест, а не сломанная выдача после оплаты.
 *
 * **Окрас в составе — конкретный облик из каталога** (`appearance`, T-0245): его id
 * проверяет схема, а выдаёт строка `appearance_grant`, не кошелёк. Случайного облика в
 * составе нет — только названный, как и самоцветы.
 *
 * **Рабочие числа (Р31)** — цены и составы ставит команда (О1). Опора: звезда
 * игроку — 1,72 ₽ (Р37), буст за самоцветы — 4–6, самоцветы за уровень — 10
 * каждый пятый; крупный набор выгоднее мелкого, стартовый — самый выгодный и
 * один на аккаунт.
 */

/** Что продаётся — ресурсы кошелька ровно в этих количествах. */
export const SHOP_RESOURCES = ["gems"] as const satisfies readonly WalletResource[];
export type ShopResource = (typeof SHOP_RESOURCES)[number];

export const SHOP_KINDS = ["gems", "bundle", "starter"] as const;
export type ShopKind = (typeof SHOP_KINDS)[number];

/** Название в окне оплаты Telegram — до 32 знаков, с запасом на пометку тестовой оплаты. */
export const TITLE_MAX = 25;

/** Облик, которого нет в каталоге обликов, продать нельзя: выдавать было бы нечего. */
const appearanceIdSchema = z.string().refine((id) => appearanceById(id) !== undefined, { message: "облика нет в каталоге обликов" });

const contentsSchema = z.object({ gems: z.number().int().positive(), appearance: appearanceIdSchema.optional() }).strict();

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
    /**
     * «Хит» — товар, который команда выделяет сама. «Лучшая цена» и выгода
     * считаются, а не ставятся руками: они обязаны быть правдой.
     */
    badge: z.enum(["hit"]).optional(),
  })
  .strict();

export type ShopSku = z.infer<typeof shopSkuSchema>;

export const SHOP_SKUS: readonly ShopSku[] = [
  {
    id: "starter",
    kind: "starter",
    contents: { gems: 150 },
    title: "Стартовый набор",
    description: "150 самоцветов — один раз на аккаунт, в 2,5 раза выгоднее малого набора.",
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
    badge: "hit",
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
  // Набор хранителя (Р155, T-0245): виден только 48 часов после первой победы над Рубежом
  // (`keeper-set.ts`). Цена и самоцветы — как у пакета на 330, окрас — в подарок; зачёркнутой
  // цены нет: настоящая прежняя цена бывает только у акции, а акции на набор не действуют.
  {
    id: KEEPER_SET_SKU,
    kind: "bundle",
    contents: { gems: 330, appearance: "dawn" },
    title: "Набор хранителя",
    description: "330 самоцветов и окрас «Хранитель · рассвет» — один раз на аккаунт, только 48 часов после первой победы над Рубежом.",
    baseRub: "430",
    stars: 250,
    once: true,
    sort: 5,
  },
];

export function skuById(id: string): ShopSku | undefined {
  return SHOP_SKUS.find((sku) => sku.id === id);
}

/** Товар для слоя цен WP9: базовая цена и ручная — в звёздах. */
export function priceProduct(sku: ShopSku): Product {
  return { id: sku.id, base: { currency: "RUB", amount: sku.baseRub }, manual: { telegram_stars: String(sku.stars) } };
}

/** Окрас, который идёт в составе, — id облика; `null` — у товара окраса нет. */
export function appearanceOf(sku: ShopSku): string | null {
  return sku.contents.appearance ?? null;
}

/** Состав как пары «ресурс — сколько», в порядке ресурсов. */
export function contentsOf(sku: ShopSku): { resource: ShopResource; amount: number }[] {
  return SHOP_RESOURCES.flatMap((resource) => {
    const amount = sku.contents[resource];
    return amount === undefined ? [] : [{ resource, amount }];
  });
}
