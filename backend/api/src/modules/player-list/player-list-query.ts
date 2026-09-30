import { z } from "zod";
import { ValidationError } from "../../common/domain-error.js";
import { START_KINDS } from "../attribution/start-param.js";
import { PLATFORM_IDS } from "../../platforms/ports/platform.js";

/**
 * Запрос списка игроков в панели (docs/35-stage4-plan.md WP32): фильтры,
 * сортировка и курсор. Всё из адресной строки — граница: разбирается
 * схемой, а в SQL попадают только значения параметрами и колонки из белого
 * списка по ключу сортировки.
 */

export const PLAYER_SORTS = ["registered", "seen", "level"] as const;
export type PlayerSort = (typeof PLAYER_SORTS)[number];

export const PLAYER_LIST_PAGE_DEFAULT = 50;
export const PLAYER_LIST_PAGE_MAX = 100;
/** Уровень — не выше этого: больше в игре нет, а число без потолка — повод для мусора в запросе. */
const LEVEL_MAX = 999;

const yesNo = z.enum(["yes", "no"]).transform((value) => value === "yes");
const moment = z.iso.datetime({ offset: true }).or(z.iso.date()).transform((value) => new Date(value));
const level = z.coerce.number().int().min(1).max(LEVEL_MAX);

export const playerListQuerySchema = z
  .object({
    platform: z.enum(PLATFORM_IDS).optional(),
    levelMin: level.optional(),
    levelMax: level.optional(),
    registeredFrom: moment.optional(),
    registeredTo: moment.optional(),
    seenFrom: moment.optional(),
    seenTo: moment.optional(),
    /** вид первого касания — откуда пришёл */
    source: z.enum(START_KINDS).optional(),
    /** кампания ссылки первого касания — формат тот же, что у ссылок кампаний */
    campaign: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .optional(),
    payer: yesNo.optional(),
    banned: yesNo.optional(),
    canMessage: yesNo.optional(),
    sort: z.enum(PLAYER_SORTS).default("registered"),
    order: z.enum(["desc", "asc"]).default("desc"),
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(PLAYER_LIST_PAGE_MAX).default(PLAYER_LIST_PAGE_DEFAULT),
  })
  .strict()
  .refine((query) => query.levelMin === undefined || query.levelMax === undefined || query.levelMin <= query.levelMax, "Уровень «от» больше уровня «до»")
  .refine((query) => query.registeredFrom === undefined || query.registeredTo === undefined || query.registeredFrom < query.registeredTo, "Начало регистрации позже конца")
  .refine((query) => query.seenFrom === undefined || query.seenTo === undefined || query.seenFrom < query.seenTo, "Начало захода позже конца");

export type PlayerListQuery = z.output<typeof playerListQuerySchema>;

/** Фильтры без сортировки и страницы — то, что уходит в условие выборки. */
export type PlayerFilters = Omit<PlayerListQuery, "sort" | "order" | "cursor" | "limit">;

/**
 * Где остановилась страница: значение ключа сортировки и id последней строки
 * — строки с одинаковым ключом на границе страниц не теряются и не
 * повторяются. Время — миллисекундами, уровень — числом.
 */
export interface PlayerCursor {
  sort: PlayerSort;
  value: number;
  accountId: string;
}

export function encodePlayerCursor(cursor: PlayerCursor): string {
  return Buffer.from(`${cursor.sort}:${String(cursor.value)}:${cursor.accountId}`, "utf8").toString("base64url");
}

const CURSOR = /^(registered|seen|level):(\d{1,15}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Курсор другой сортировки — ошибка запроса, а не страница с середины чужого порядка. */
export function decodePlayerCursor(value: string, sort: PlayerSort): PlayerCursor {
  const match = CURSOR.exec(Buffer.from(value, "base64url").toString("utf8"));
  if (match === null || match[1] !== sort) throw new ValidationError("Некорректный курсор списка игроков");
  return { sort, value: Number(match[2]), accountId: match[3] ?? "" };
}
