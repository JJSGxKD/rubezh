import { z } from "zod";
import { MERGE_COUNT, RARITY_RULES } from "../item-catalog.js";

/**
 * Граница снаряжения (docs/35-stage4-plan.md §3.4, WP7). Клиент называет
 * предмет и действие, а не результат: что выпадет и сколько стоит, решает
 * сервер по строке в базе.
 *
 * Ключ операции — uuid на нажатие: двойное нажатие и повтор после обрыва
 * связи не спишут цену дважды.
 */

const idempotencyKey = z.string().uuid();

export const itemIdSchema = z.string().uuid();

export const itemOperationSchema = z.object({ idempotencyKey });

/** Номер дополнительного свойства — не больше, чем их бывает у самой щедрой редкости. */
const MAX_EXTRAS = Math.max(...Object.values(RARITY_RULES).map((rules) => rules.extras));

export const itemRerollSchema = z.object({ idempotencyKey, index: z.number().int().min(0).max(MAX_EXTRAS - 1) });

export const itemMergeSchema = z.object({ idempotencyKey, itemIds: z.array(z.string().uuid()).length(MERGE_COUNT) });
