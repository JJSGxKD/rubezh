import { Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { pluralRu } from "../../common/card/labels.js";
import { withTimeout } from "../../common/with-timeout.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { SHOP_SKUS, shopSkuSchema, type ShopSku } from "./shop-catalog.js";

/**
 * Правка товара поверх каталога в коде (docs/19-content-admin.md §6,
 * tasks/T-0309). Каталог остаётся в `shop-catalog.ts`: новый товар, его вид и
 * «один на аккаунт» — только код. Панель правит пять полей — цену в звёздах и в
 * рублях, самоцветы состава, значок «Хит» и порядок, — и только заявкой с
 * подтверждением второго участника (`change-requests/`).
 *
 * **Правка проверяется той же схемой, что и каталог.** Товар с правкой
 * собирается и разбирается `shopSkuSchema`; не прошёл — витрина берёт товар из
 * кода, а не портит цену. Поле, которого схема правки не знает, правкой не
 * бывает: `id`, `kind` и `once` в неё не попадут.
 *
 * **Состав изменён — тексты счёта пересобираются по новому числу.** Название и
 * описание уходят в окно оплаты площадки; «330 самоцветов» при составе в 360
 * обещало бы не то, что получит игрок.
 */

/** Поля, которые можно править; `badge: null` снимает «Хит». */
export const skuOverrideSchema = z
  .object({
    stars: shopSkuSchema.shape.stars,
    baseRub: shopSkuSchema.shape.baseRub,
    contents: shopSkuSchema.shape.contents,
    badge: z.enum(["hit"]).nullable(),
    sort: shopSkuSchema.shape.sort,
  })
  .partial()
  .strict()
  .refine((fields) => Object.keys(fields).length > 0, { message: "Правка пуста" });

export type SkuOverride = z.infer<typeof skuOverrideSchema>;

/** Правка в виде, в каком её показывает заявка: значения полей товара, без пропусков. */
export type SkuFieldValues = {
  stars: number;
  baseRub: string;
  contents: { gems: number };
  badge: "hit" | null;
  sort: number;
};

const GEMS = (count: number): string => pluralRu(count, "самоцвет", "самоцвета", "самоцветов");

/** Тексты окна оплаты под новое число самоцветов: прежние обещали бы старый состав. */
function gemsTexts(sku: ShopSku, gems: number): Pick<ShopSku, "title" | "description"> {
  const count = `${String(gems)} ${GEMS(gems)}`;
  return {
    title: sku.kind === "gems" ? count : sku.title,
    description: `${count} на счёт${sku.once ? " — один раз на аккаунт" : ""}.`,
  };
}

/**
 * Товар с правкой поверх каталога. `null` — склеенное не прошло схему товара:
 * вызывающий решает, что делать (витрина берёт товар из кода, заявка — отказ).
 */
export function applyOverride(sku: ShopSku, override: SkuOverride | undefined): ShopSku | null {
  if (override === undefined) return sku;
  const { contents, badge, ...scalars } = override;
  const merged: Record<string, unknown> = { ...sku, ...scalars };
  if (contents !== undefined) {
    merged.contents = { ...sku.contents, ...contents };
    if (contents.gems !== undefined && contents.gems !== sku.contents.gems) Object.assign(merged, gemsTexts(sku, contents.gems));
  }
  if (badge === null) delete merged.badge;
  else if (badge !== undefined) merged.badge = badge;
  const parsed = shopSkuSchema.safeParse(merged);
  return parsed.success ? parsed.data : null;
}

/** Две правки подряд: поля новой перекрывают поля прежней, состав заменяется целиком — в нём одно поле. */
export function mergeOverrides(stored: SkuOverride | undefined, change: SkuOverride): SkuOverride {
  return { ...stored, ...change };
}

/** Значения всех правимых полей товара — «было» и «сейчас» в заявке и в панели. */
export function fieldValues(sku: ShopSku): SkuFieldValues {
  return { stars: sku.stars, baseRub: sku.baseRub, contents: { gems: sku.contents.gems }, badge: sku.badge ?? null, sort: sku.sort };
}

export interface ShopOverrideRow {
  skuId: string;
  fields: unknown;
  setBy: string;
  setAt: Date;
}

export const SHOP_OVERRIDE_REPOSITORY = Symbol("SHOP_OVERRIDE_REPOSITORY");

export interface ShopOverrideRepository {
  all(): Promise<ShopOverrideRow[]>;
}

/** Без правок — тесты и сборки, где базы нет: витрина совпадает с каталогом в коде. */
export const NO_SHOP_OVERRIDES: ShopOverrideRepository = { all: async () => [] };

/** Правок единицы, читаются на каждый заказ и открытие витрины: короткий кэш разгружает базу, а чужая реплика отстаёт на секунды. */
const CACHE_TTL_MS = 10_000;
const DB_TIMEOUT_MS = 3_000;

/**
 * Товары магазина, какими их видит игрок: каталог в коде и правки команды
 * поверх. Витрина, счёт и выдача берут товар отсюда, а не из `SHOP_SKUS`.
 */
@Injectable()
export class ShopOverrides {
  private readonly logger = new Logger("shop");
  private cache: { skus: readonly ShopSku[]; until: number } | null = null;

  constructor(@Inject(SHOP_OVERRIDE_REPOSITORY) private readonly repository: ShopOverrideRepository) {}

  /** Все товары в порядке каталога. `fresh` — мимо кэша: панель показывает то, что в базе сейчас. */
  async skus(options: { fresh?: boolean } = {}): Promise<readonly ShopSku[]> {
    const now = Date.now();
    if (options.fresh !== true && this.cache !== null && this.cache.until > now) return this.cache.skus;
    try {
      const skus = this.assemble(await withTimeout(this.repository.all(), DB_TIMEOUT_MS, "правки товаров"));
      this.cache = { skus, until: now + CACHE_TTL_MS };
      return skus;
    } catch (error: unknown) {
      // Цена из прошлого чтения лучше, чем отказ витрины от сбоя базы на долю секунды; без неё ответить нечем.
      if (this.cache === null || options.fresh === true) throw error;
      this.logger.warn(JSON.stringify({ module: "shop", event: "overrides_stale", reason: error instanceof Error ? error.message : "unknown" }));
      return this.cache.skus;
    }
  }

  async sku(id: string): Promise<ShopSku | undefined> {
    return (await this.skus()).find((sku) => sku.id === id);
  }

  /** После применения правки на этой реплике: следующее чтение идёт в базу. */
  invalidate(): void {
    this.cache = null;
  }

  private assemble(rows: readonly ShopOverrideRow[]): readonly ShopSku[] {
    const byId = new Map(rows.map((row) => [row.skuId, row]));
    return SHOP_SKUS.map((sku) => {
      const row = byId.get(sku.id);
      if (row === undefined) return sku;
      const fields = skuOverrideSchema.safeParse(row.fields);
      const merged = fields.success ? applyOverride(sku, fields.data) : null;
      if (merged !== null) return merged;
      // Битая правка не должна ломать витрину: товар остаётся из кода, а команда узнаёт из лога.
      this.logger.error(JSON.stringify({ module: "shop", event: "override_invalid", sku: sku.id }));
      return sku;
    });
  }
}

@Injectable()
export class PrismaShopOverrideRepository implements ShopOverrideRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async all(): Promise<ShopOverrideRow[]> {
    const rows = await this.prisma.shopSkuOverride.findMany();
    return rows.map((row) => ({ skuId: row.skuId, fields: row.fields, setBy: row.setBy, setAt: row.setAt }));
  }
}
