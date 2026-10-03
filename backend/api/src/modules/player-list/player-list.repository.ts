import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { PlayerCursor, PlayerFilters, PlayerSort } from "./player-list-query.js";

/**
 * Список игроков для панели (docs/35-stage4-plan.md WP32) — модель чтения
 * поверх аккаунта, уровня, первого касания, воронки и «можно ли писать», как
 * сегмент рассылки (`broadcasts/broadcasts.repository.ts`).
 *
 * Сортировка и страница — по индексу, а не сортировкой всей выборки
 * (критерий приёмки WP32): курсор — ключ сортировки и id последней строки, и
 * запрос идёт по индексу `(ключ, account_id)` до `LIMIT`. Уровня у аккаунта
 * до первой награды нет — это первый уровень, — поэтому сортировка по уровню
 * идёт двумя отрезками: прокачанные — по индексу уровня в `account_progress`,
 * остальные — по первичному ключу аккаунта.
 */

export interface PlayerListRow {
  accountId: string;
  platform: string;
  displayName: string;
  photoUrl: string | null;
  platformUserId: string;
  username: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  bannedAt: Date | null;
  banReason: string | null;
  /** виды действующих ограничений — по алфавиту */
  restrictions: string[];
  level: number;
  /** вид первого касания; `null` — касаний нет (вход до атрибуции) */
  source: string | null;
  /** кампания ссылки первого касания */
  campaign: string | null;
  payer: boolean;
  /** `null` — строки «можно писать» нет: игрок не начинал разговор с ботом */
  canMessage: boolean | null;
}

export interface PlayerPage {
  filters: PlayerFilters;
  sort: PlayerSort;
  order: "asc" | "desc";
  cursor: PlayerCursor | null;
  /** сколько строк вернуть — на одну больше страницы, чтобы знать, есть ли следующая */
  limit: number;
}

export const PLAYER_LIST_REPOSITORY = Symbol("PLAYER_LIST_REPOSITORY");

export interface PlayerListRepository {
  page(page: PlayerPage): Promise<PlayerListRow[]>;
}

const rowSchema = z.object({
  account_id: z.string(),
  platform: z.string(),
  display_name: z.string(),
  photo_url: z.string().nullable(),
  platform_user_id: z.string(),
  username: z.string().nullable(),
  created_at: z.date(),
  last_seen_at: z.date(),
  banned_at: z.date().nullable(),
  ban_reason: z.string().nullable(),
  restrictions: z.array(z.string()),
  level: z.number().int(),
  source: z.string().nullable(),
  campaign: z.string().nullable(),
  payer: z.boolean(),
  can_message: z.boolean().nullable(),
});

/**
 * Действующее ограничение аккаунта строки: не снято и срок не вышел. Ещё не
 * сведённое — условие идёт по индексу `(account_id, starts_at)` и не
 * трогает историю.
 */
const ACTIVE_RESTRICTION = Prisma.sql`r.account_id = a.account_id AND r.settled_at IS NULL AND r.lifted_at IS NULL AND (r.ends_at IS NULL OR r.ends_at > now())`;

const SELECT = Prisma.sql`
  SELECT a.account_id, a.platform::text AS platform, a.display_name, a.photo_url, a.platform_user_id, a.username,
    a.created_at, a.last_seen_at, a.banned_at, a.ban_reason,
    ARRAY(SELECT r.kind::text FROM account_restriction r WHERE ${ACTIVE_RESTRICTION} ORDER BY r.kind) AS restrictions,
    COALESCE(p.level, 1) AS level,
    q.first_start_kind::text AS source,
    (SELECT l.campaign FROM link_click lc JOIN link l ON l.code = lc.link_code
      WHERE q.first_start_kind = 'click' AND lc.click_id = q.first_start_ref) AS campaign,
    f.first_purchase_at IS NOT NULL AS payer,
    m.can_message
  FROM account a
  LEFT JOIN account_progress p ON p.account_id = a.account_id
  LEFT JOIN acquisition q ON q.account_id = a.account_id
  LEFT JOIN account_funnel f ON f.account_id = a.account_id
  LEFT JOIN account_messaging m ON m.account_id = a.account_id`;

/** Условия фильтров, кроме уровня: уровень у сортировки по нему свой, по отрезкам. */
export function filterConditions(filters: PlayerFilters): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (filters.platform !== undefined) conditions.push(Prisma.sql`a.platform = ${filters.platform}::"Platform"`);
  if (filters.registeredFrom !== undefined) conditions.push(Prisma.sql`a.created_at >= ${filters.registeredFrom}`);
  if (filters.registeredTo !== undefined) conditions.push(Prisma.sql`a.created_at < ${filters.registeredTo}`);
  if (filters.seenFrom !== undefined) conditions.push(Prisma.sql`a.last_seen_at >= ${filters.seenFrom}`);
  if (filters.seenTo !== undefined) conditions.push(Prisma.sql`a.last_seen_at < ${filters.seenTo}`);
  if (filters.source !== undefined) conditions.push(Prisma.sql`q.first_start_kind = ${filters.source}::"StartKind"`);
  if (filters.campaign !== undefined) {
    conditions.push(Prisma.sql`q.first_start_kind = 'click' AND EXISTS (
      SELECT 1 FROM link_click lc JOIN link l ON l.code = lc.link_code
      WHERE lc.click_id = q.first_start_ref AND l.campaign = ${filters.campaign})`);
  }
  if (filters.payer !== undefined) conditions.push(filters.payer ? Prisma.sql`f.first_purchase_at IS NOT NULL` : Prisma.sql`f.first_purchase_at IS NULL`);
  if (filters.banned !== undefined) conditions.push(filters.banned ? Prisma.sql`a.banned_at IS NOT NULL` : Prisma.sql`a.banned_at IS NULL`);
  if (filters.restricted === "any") conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM account_restriction r WHERE ${ACTIVE_RESTRICTION})`);
  else if (filters.restricted === "none") conditions.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM account_restriction r WHERE ${ACTIVE_RESTRICTION})`);
  else if (filters.restricted !== undefined) conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM account_restriction r WHERE ${ACTIVE_RESTRICTION} AND r.kind = ${filters.restricted})`);
  if (filters.canMessage !== undefined) conditions.push(filters.canMessage ? Prisma.sql`m.can_message` : Prisma.sql`m.can_message IS NOT TRUE`);
  return conditions;
}

/** Потолок уровня, когда фильтра «до» нет, — в пределах `integer` колонки уровня. */
const NO_LEVEL_CAP = 2_147_483_647;

function levelRange(filters: PlayerFilters): { min: number; max: number } {
  return { min: filters.levelMin ?? 1, max: filters.levelMax ?? NO_LEVEL_CAP };
}

function where(conditions: Prisma.Sql[]): Prisma.Sql {
  return conditions.length === 0 ? Prisma.empty : Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;
}

/**
 * Запрос страницы при сортировке по регистрации или заходу: отрезок индекса
 * `(ключ, account_id)` после курсора до `LIMIT`.
 */
export function timeOrderedSql(page: PlayerPage): Prisma.Sql {
  const column = page.sort === "registered" ? Prisma.sql`a.created_at` : Prisma.sql`a.last_seen_at`;
  const { min, max } = levelRange(page.filters);
  const conditions = filterConditions(page.filters);
  if (min > 1 || max < NO_LEVEL_CAP) conditions.push(Prisma.sql`COALESCE(p.level, 1) BETWEEN ${min} AND ${max}`);
  if (page.cursor !== null) {
    const at = new Date(page.cursor.value);
    conditions.push(page.order === "desc" ? Prisma.sql`(${column}, a.account_id) < (${at}, ${page.cursor.accountId}::uuid)` : Prisma.sql`(${column}, a.account_id) > (${at}, ${page.cursor.accountId}::uuid)`);
  }
  const direction = page.order === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  return Prisma.sql`${SELECT} ${where(conditions)} ORDER BY ${column} ${direction}, a.account_id ${direction} LIMIT ${page.limit}`;
}

export type LevelSegment = "levelled" | "first";

/**
 * Отрезки сортировки по уровню в порядке обхода. Курсор первого уровня при
 * убывании — прокачанные уже пройдены; прокачанный при возрастании — пройден
 * первый уровень. Отрезок вне фильтра уровня не обходится вовсе.
 */
export function levelSegments(page: Pick<PlayerPage, "order" | "cursor" | "filters">): LevelSegment[] {
  const { min, max } = levelRange(page.filters);
  const inFirstLevel = page.cursor !== null && page.cursor.value <= 1;
  const order: LevelSegment[] = page.order === "desc" ? ["levelled", "first"] : ["first", "levelled"];
  return order.filter((segment) => {
    if (segment === "first") return min <= 1 && !(page.order === "asc" && page.cursor !== null && !inFirstLevel);
    return max >= 2 && !(page.order === "desc" && inFirstLevel);
  });
}

/** Запрос отрезка: прокачанные — по индексу уровня, первый уровень — по первичному ключу аккаунта. */
export function levelSegmentSql(page: PlayerPage, segment: LevelSegment, limit: number): Prisma.Sql {
  const { min, max } = levelRange(page.filters);
  const cursor = page.cursor;
  const inFirstLevel = cursor !== null && cursor.value <= 1;
  const desc = page.order === "desc";
  const direction = desc ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  const conditions = filterConditions(page.filters);
  if (segment === "first") {
    conditions.push(Prisma.sql`(p.level IS NULL OR p.level <= 1)`);
    if (cursor !== null && inFirstLevel) conditions.push(desc ? Prisma.sql`a.account_id < ${cursor.accountId}::uuid` : Prisma.sql`a.account_id > ${cursor.accountId}::uuid`);
    return Prisma.sql`${SELECT} ${where(conditions)} ORDER BY a.account_id ${direction} LIMIT ${limit}`;
  }
  conditions.push(Prisma.sql`p.level BETWEEN ${Math.max(min, 2)} AND ${max}`);
  if (cursor !== null && !inFirstLevel) {
    conditions.push(desc ? Prisma.sql`(p.level, p.account_id) < (${cursor.value}, ${cursor.accountId}::uuid)` : Prisma.sql`(p.level, p.account_id) > (${cursor.value}, ${cursor.accountId}::uuid)`);
  }
  return Prisma.sql`${SELECT} ${where(conditions)} ORDER BY p.level ${direction}, p.account_id ${direction} LIMIT ${limit}`;
}

@Injectable()
export class PrismaPlayerListRepository implements PlayerListRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async page(page: PlayerPage): Promise<PlayerListRow[]> {
    if (page.sort !== "level") return await this.query(timeOrderedSql(page));
    // Уровень — двумя отрезками, каждый по своему индексу: второй добирает то, чего не хватило первому.
    const rows: PlayerListRow[] = [];
    for (const segment of levelSegments(page)) {
      if (rows.length >= page.limit) break;
      rows.push(...(await this.query(levelSegmentSql(page, segment, page.limit - rows.length))));
    }
    return rows;
  }

  private async query(sql: Prisma.Sql): Promise<PlayerListRow[]> {
    const rows = z.array(rowSchema).parse(await this.prisma.$queryRaw(sql));
    return rows.map((row) => ({
      accountId: row.account_id,
      platform: row.platform,
      displayName: row.display_name,
      photoUrl: row.photo_url,
      platformUserId: row.platform_user_id,
      username: row.username,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      bannedAt: row.banned_at,
      banReason: row.ban_reason,
      restrictions: row.restrictions,
      level: row.level,
      source: row.source,
      campaign: row.campaign,
      payer: row.payer,
      canMessage: row.can_message,
    }));
  }
}
