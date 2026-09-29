import { z } from "zod";

/**
 * Виды уведомлений и их данные (docs/35-stage4-plan.md Р51, §3.17). Данные —
 * граница: пишутся модулями, читаются из JSON базы и уходят клиенту, поэтому
 * у каждого вида своя схема. Вид, которого код больше не знает, и данные не по
 * схеме в ленту не попадают.
 *
 * Имена другого игрока — копия на момент события: переименование позже ленту
 * не переписывает, а чужое имя не длиннее, чем влезает в строку ленты.
 */

const name = z.string().min(1).max(64);
const id = z.string().min(1).max(64);

export const NOTIFICATION_KINDS = {
  /** заявка в друзья */
  friend_request: z.object({ fromAccountId: z.string().uuid(), fromName: name }),
  /** подарок друга ждёт, чтобы его забрали */
  friend_gift: z.object({ fromAccountId: z.string().uuid(), fromName: name }),
  /** редкая добыча забега */
  rare_loot: z.object({ itemId: z.string().uuid(), slot: id, rarity: id, salvaged: z.boolean() }),
  /** бусты вернулись: забег так и не начался */
  boosts_refunded: z.object({ runId: id, boosts: z.array(id).max(8), coins: z.number().int().nonnegative(), gems: z.number().int().nonnegative() }),
} as const;

export type NotificationKind = keyof typeof NOTIFICATION_KINDS;

export type NotificationPayload<K extends NotificationKind> = z.infer<(typeof NOTIFICATION_KINDS)[K]>;

export function isNotificationKind(value: string): value is NotificationKind {
  return Object.hasOwn(NOTIFICATION_KINDS, value);
}

/** Редкая добыча — от эпической: об обычной и добротной игрок узнает в арсенале. */
export const RARE_LOOT_RARITIES: ReadonlySet<string> = new Set(["epic", "legendary", "mythic"]);

/** Сколько хранится уведомление: дольше лента — архив, а не новости. */
export const NOTIFICATION_RETENTION_DAYS = 90;
