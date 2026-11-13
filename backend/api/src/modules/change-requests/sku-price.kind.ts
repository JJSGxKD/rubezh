import { Injectable } from "@nestjs/common";
import type { ZodError } from "zod";
import { skuById, SHOP_SKUS } from "../shop/shop-catalog.js";
import { ShopSkuNotFoundError } from "../shop/shop-errors.js";
import { ShopOverrides, applyOverride, fieldValues, mergeOverrides, skuOverrideSchema, type SkuFieldValues, type SkuOverride } from "../shop/shop-overrides.js";
import type { ChangeKindHandler } from "./change-request-kinds.js";
import { ChangeRequestValueError } from "./change-request-errors.js";
import { sameJson } from "./change-request-rules.js";
import type { ChangeRequestRow, ChangeTargetView, ChangeTx, JsonValue } from "./change-request-types.js";

/**
 * Вид правки «цена товара» (docs/19-content-admin.md §6, tasks/T-0309):
 * цель — товар каталога в коде, правка ложится в `shop_sku_override` поверх
 * него. Правятся цена в звёздах и в рублях, самоцветы состава, значок «Хит» и
 * порядок; `id`, вид и «один на аккаунт» — нет: новый товар — код.
 *
 * «Было» сервер берёт сам — из каталога с уже действующей правкой, — а то, что
 * заявка оставляет прежним, из неё убирает: подтверждающий видит ровно то, что
 * изменится, и условие «цель всё ещё равна было» сравнивает только эти поля.
 */

/** Поля правки в порядке показа: так их читает человек и так сервер пишет строку для чата. */
const FIELD_ORDER = ["stars", "baseRub", "contents", "badge", "sort"] as const;
type FieldKey = (typeof FIELD_ORDER)[number];

const FIELD_HINTS: Record<FieldKey, string> = {
  stars: "Цена в звёздах: целое число от 1 до 10 000",
  baseRub: "Цена в рублях: число с копейками, например 86 или 86.50",
  contents: "Состав набора: только самоцветы",
  badge: "Значок: «Хит» или без значка",
  sort: "Порядок на витрине: целое число",
};

function isFieldKey(value: unknown): value is FieldKey {
  return FIELD_ORDER.some((key) => key === value);
}

/** Первая ошибка схемы — словами: поле и предел, а не код Zod. */
function problemText(error: ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "Правка не по правилам каталога";
  if (issue.code === "unrecognized_keys") return `Поля «${issue.keys.join("», «")}» править нельзя: правятся цена, состав набора, значок и порядок`;
  const [head, tail] = issue.path;
  if (head === "contents" && tail === "gems") return "Самоцветов в наборе: целое число больше нуля";
  if (isFieldKey(head)) return FIELD_HINTS[head];
  return "В заявке нет изменений: укажите хотя бы одно поле";
}

/** Значения только перечисленных полей: ровно то, что хранит «было». */
function pickValues(values: SkuFieldValues, keys: readonly string[]): Record<string, JsonValue> {
  const picked: Record<string, JsonValue> = {};
  for (const key of FIELD_ORDER) {
    if (keys.includes(key)) picked[key] = values[key];
  }
  return picked;
}

function keysOf(value: JsonValue): string[] {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

const BADGE_TEXT = (badge: unknown): string => (badge === "hit" ? "«Хит»" : "нет");

function field(value: JsonValue, key: string): JsonValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value[key] : undefined;
}

/** «Название: цена 50 → 60 ⭐; …» — одна строка для чата и журнала. */
export function describeSkuChange(target: string, before: JsonValue, after: JsonValue): string {
  const title = skuById(target)?.title ?? target;
  const parts: string[] = [];
  for (const key of FIELD_ORDER) {
    const was = field(before, key);
    const now = field(after, key);
    if (now === undefined) continue;
    switch (key) {
      case "stars":
        parts.push(`цена ${String(was ?? "—")} → ${String(now)} ⭐`);
        break;
      case "baseRub":
        parts.push(`цена ${String(was ?? "—")} → ${String(now)} ₽`);
        break;
      case "contents":
        parts.push(`самоцветов ${String(field(was ?? null, "gems") ?? "—")} → ${String(field(now, "gems") ?? "—")}`);
        break;
      case "badge":
        parts.push(`значок ${BADGE_TEXT(was)} → ${BADGE_TEXT(now)}`);
        break;
      case "sort":
        parts.push(`порядок ${String(was ?? "—")} → ${String(now)}`);
        break;
    }
  }
  return `${title}: ${parts.join("; ")}`;
}

@Injectable()
export class SkuPriceKind implements ChangeKindHandler {
  readonly kind = "sku_price" as const;
  readonly permission = "sku.price.edit" as const;

  constructor(private readonly overrides: ShopOverrides) {}

  async prepare(tx: ChangeTx, target: string, input: unknown): Promise<{ before: JsonValue; after: JsonValue }> {
    const base = skuById(target);
    if (base === undefined) throw new ShopSkuNotFoundError();
    const parsed = skuOverrideSchema.safeParse(input);
    if (!parsed.success) throw new ChangeRequestValueError(problemText(parsed.error));

    const stored = await this.stored(tx, target);
    const now = fieldValues(applyOverride(base, stored) ?? base);
    const before: Record<string, JsonValue> = {};
    const after: Record<string, JsonValue> = {};
    for (const key of FIELD_ORDER) {
      const wanted = parsed.data[key];
      if (wanted === undefined || sameJson(wanted, now[key])) continue;
      before[key] = now[key];
      after[key] = wanted;
    }
    if (Object.keys(after).length === 0) throw new ChangeRequestValueError("Ничего не меняется: в заявке те же значения, что сейчас");

    // Итог проходит схему каталога целиком: правка по полям могла быть верной, а вместе с прежней — нет.
    const change = skuOverrideSchema.safeParse(after);
    if (!change.success || applyOverride(base, mergeOverrides(stored, change.data)) === null) throw new ChangeRequestValueError("Итог не проходит правила каталога товаров");
    return { before, after };
  }

  async current(tx: ChangeTx, request: ChangeRequestRow): Promise<JsonValue> {
    const base = skuById(request.target);
    // Товар ушёл из каталога выкатом: «было» описывало то, чего больше нет, — заявка устарела.
    if (base === undefined) return null;
    const effective = applyOverride(base, await this.stored(tx, request.target)) ?? base;
    return pickValues(fieldValues(effective), keysOf(request.before));
  }

  async apply(tx: ChangeTx, request: ChangeRequestRow, by: string, at: Date): Promise<void> {
    const base = skuById(request.target);
    if (base === undefined) throw new ShopSkuNotFoundError();
    const change = skuOverrideSchema.safeParse(request.after);
    if (!change.success) throw new ChangeRequestValueError(problemText(change.error));
    const fields = mergeOverrides(await this.stored(tx, request.target), change.data);
    if (applyOverride(base, fields) === null) throw new ChangeRequestValueError("Итог не проходит правила каталога товаров");
    await tx.shopSkuOverride.upsert({
      where: { skuId: request.target },
      create: { skuId: request.target, fields, setBy: by, setAt: at },
      update: { fields, setBy: by, setAt: at },
    });
  }

  afterCommit(): void {
    this.overrides.invalidate();
  }

  async targets(): Promise<ChangeTargetView[]> {
    const effective = new Map((await this.overrides.skus({ fresh: true })).map((sku) => [sku.id, sku]));
    return SHOP_SKUS.map((base) => {
      const current = fieldValues(effective.get(base.id) ?? base);
      const inCode = fieldValues(base);
      return { target: base.id, title: base.title, current, inCode, overridden: !sameJson(current, inCode) };
    });
  }

  describe(request: ChangeRequestRow): string {
    return describeSkuChange(request.target, request.before, request.after);
  }

  /** Сохранённая правка товара; нечитаемая — как будто её нет: каталог остаётся в силе. */
  private async stored(tx: ChangeTx, skuId: string): Promise<SkuOverride | undefined> {
    const row = await tx.shopSkuOverride.findUnique({ where: { skuId } });
    if (row === null) return undefined;
    const parsed = skuOverrideSchema.safeParse(row.fields);
    return parsed.success ? parsed.data : undefined;
  }
}
