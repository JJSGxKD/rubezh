import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { ACHIEVEMENT_PERIOD_START } from "../tasks/tasks.repository.js";
import { RARITY_QUERY_TIMEOUT_MS } from "./achievement-rules.js";

/**
 * Хранилище достижений (tasks/T-0106): престиж, избранное и редкость. Определения
 * и прогресс читает и пишет модуль заданий — здесь только то, что добавляет витрина.
 *
 * Все запросы — по индексам аккаунта; единственный тяжёлый — пересчёт редкости,
 * он идёт фоновой задачей под потолком времени запроса и не мешает игрокам.
 */

export interface RarityRow {
  holders: number;
  population: number;
}

export interface RarityState {
  rows: Map<string, RarityRow>;
  /** последний пересчёт; `null` — таблица пуста */
  computedAt: Date | null;
}

export interface RarityReport {
  rows: number;
  population: number;
  computedAt: Date;
}

export type FavoritesResult =
  /** `changed: false` — игрок прислал то, что уже стояло, и ничего не записано */
  | { status: "ok"; ids: string[]; changed: boolean }
  /** среди присланных есть не выполненные этим игроком: ничего не записано */
  | { status: "missing"; missing: string[] };

export const ACHIEVEMENTS_REPOSITORY = Symbol("ACHIEVEMENTS_REPOSITORY");

export interface AchievementsRepository {
  /** Сумма престижа выполненных достижений, и выключенных в панели тоже. */
  prestige(accountId: string): Promise<number>;
  /** То же для нескольких аккаунтов одним запросом; у не имеющего достижений — ноль. */
  prestigeOf(accountIds: readonly string[]): Promise<Map<string, number>>;
  /** Любимые достижения по порядку слотов. */
  favorites(accountId: string): Promise<string[]>;
  /**
   * Заменить избранное одной транзакцией под блокировкой строки аккаунта: два запроса
   * игрока разом идут друг за другом, а не врозь по ключам таблицы. Каждое достижение
   * должно быть выполнено этим игроком.
   */
  replaceFavorites(accountId: string, ids: readonly string[]): Promise<FavoritesResult>;
  rarity(): Promise<RarityState>;
  rarityComputedAt(): Promise<Date | null>;
  /**
   * Пересчитать редкость и заменить таблицу одной транзакцией: читатели видят либо
   * старые числа, либо новые, и пересчёт, не уложившийся в потолок, ничего не меняет.
   */
  recomputeRarity(now: Date): Promise<RarityReport>;
}

const totalSchema = z.object({ account_id: z.string(), total: z.number().int() });
const rarityRowSchema = z.object({ task_id: z.string(), holders: z.number().int(), population: z.number().int(), computed_at: z.date() });
const computedRowSchema = z.object({ task_id: z.string(), holders: z.number().int(), population: z.number().int() });
const slotSchema = z.object({ task_id: z.string() });

@Injectable()
export class PrismaAchievementsRepository implements AchievementsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async prestige(accountId: string): Promise<number> {
    const rows = await this.prestigeOf([accountId]);
    return rows.get(accountId) ?? 0;
  }

  async prestigeOf(accountIds: readonly string[]): Promise<Map<string, number>> {
    const result = new Map(accountIds.map((id) => [id, 0]));
    if (accountIds.length === 0) return result;
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT p.account_id::text AS account_id, COALESCE(sum(d.prestige), 0)::int AS total
      FROM task_progress p
      JOIN task_def d ON d.task_id = p.task_id AND d.period = 'achievement'
      WHERE p.account_id = ANY(${[...accountIds]}::uuid[]) AND p.period_start = ${ACHIEVEMENT_PERIOD_START}::date AND p.completed_at IS NOT NULL
      GROUP BY p.account_id`;
    for (const raw of rows) {
      const row = totalSchema.parse(raw);
      result.set(row.account_id, row.total);
    }
    return result;
  }

  async favorites(accountId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`SELECT task_id FROM achievement_favorite WHERE account_id = ${accountId}::uuid ORDER BY slot`;
    return rows.map((raw) => slotSchema.parse(raw).task_id);
  }

  async replaceFavorites(accountId: string, ids: readonly string[]): Promise<FavoritesResult> {
    return await this.prisma.$transaction(
      async (tx) => {
        // Строка аккаунта — под блокировкой, не мешающей внешним ключам: второй запрос
        // этого игрока ждёт здесь и читает уже новое избранное.
        const locked = await tx.$queryRaw<unknown[]>`SELECT account_id FROM account WHERE account_id = ${accountId}::uuid FOR NO KEY UPDATE`;
        if (locked.length === 0) return { status: "missing", missing: [...ids] };
        if (ids.length > 0) {
          const owned = await tx.$queryRaw<unknown[]>`
            SELECT p.task_id
            FROM task_progress p
            JOIN task_def d ON d.task_id = p.task_id AND d.period = 'achievement' AND d.category IS NOT NULL
            WHERE p.account_id = ${accountId}::uuid AND p.task_id = ANY(${[...ids]}::text[])
              AND p.period_start = ${ACHIEVEMENT_PERIOD_START}::date AND p.completed_at IS NOT NULL
            ORDER BY d.sort, d.task_id
            FOR KEY SHARE OF d`;
          const have = new Set(owned.map((raw) => slotSchema.parse(raw).task_id));
          const missing = ids.filter((id) => !have.has(id));
          if (missing.length > 0) return { status: "missing", missing };
        }
        const current = (await tx.$queryRaw<unknown[]>`SELECT task_id FROM achievement_favorite WHERE account_id = ${accountId}::uuid ORDER BY slot`).map(
          (raw) => slotSchema.parse(raw).task_id,
        );
        if (current.length === ids.length && current.every((id, index) => id === ids[index])) return { status: "ok", ids: [...ids], changed: false };
        await tx.$executeRaw`DELETE FROM achievement_favorite WHERE account_id = ${accountId}::uuid`;
        if (ids.length > 0) {
          await tx.$executeRaw`
            INSERT INTO achievement_favorite (account_id, slot, task_id)
            SELECT ${accountId}::uuid, u.slot, u.task_id
            FROM unnest(${ids.map((_id, index) => index + 1)}::int[], ${[...ids]}::text[]) AS u(slot, task_id)`;
        }
        return { status: "ok", ids: [...ids], changed: true };
      },
      { maxWait: 5_000, timeout: 10_000 },
    );
  }

  async rarity(): Promise<RarityState> {
    const rows = await this.prisma.$queryRaw<unknown[]>`SELECT task_id, holders, population, computed_at FROM achievement_rarity`;
    const state: RarityState = { rows: new Map(), computedAt: null };
    for (const raw of rows) {
      const row = rarityRowSchema.parse(raw);
      state.rows.set(row.task_id, { holders: row.holders, population: row.population });
      if (state.computedAt === null || row.computed_at > state.computedAt) state.computedAt = row.computed_at;
    }
    return state;
  }

  async rarityComputedAt(): Promise<Date | null> {
    const [row] = await this.prisma.$queryRaw<{ computed_at: Date | null }[]>`SELECT max(computed_at) AS computed_at FROM achievement_rarity`;
    return row?.computed_at ?? null;
  }

  async recomputeRarity(now: Date): Promise<RarityReport> {
    return await this.prisma.$transaction(
      async (tx) => {
        // Потолок времени — только на эту транзакцию: сбой запроса откатывает её, и прежние числа остаются.
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(RARITY_QUERY_TIMEOUT_MS)}, true)`;
        // Население — игроки хотя бы с одним записанным забегом, держатели — выполнившие среди них.
        // Игрок без забегов, но с достижением (друзья, уровень аккаунта), ни в числитель, ни в
        // знаменатель не входит: иначе «есть у N%» считалось бы не среди играющих.
        const raw = await tx.$queryRaw<unknown[]>`
          WITH pop AS MATERIALIZED (
            SELECT a.account_id FROM account a
            WHERE EXISTS (SELECT 1 FROM run r WHERE r.account_id = a.account_id AND r.status = 'finished')
          ), held AS (
            SELECT p.task_id, count(*)::int AS holders
            FROM task_progress p
            JOIN task_def d ON d.task_id = p.task_id AND d.period = 'achievement' AND d.category IS NOT NULL
            JOIN pop ON pop.account_id = p.account_id
            WHERE p.period_start = ${ACHIEVEMENT_PERIOD_START}::date AND p.completed_at IS NOT NULL
            GROUP BY p.task_id
          )
          SELECT d.task_id, COALESCE(h.holders, 0)::int AS holders, (SELECT count(*) FROM pop)::int AS population
          FROM task_def d LEFT JOIN held h ON h.task_id = d.task_id
          WHERE d.period = 'achievement' AND d.category IS NOT NULL`;
        const rows = raw.map((row) => computedRowSchema.parse(row));
        // Внешний ключ строки редкости берёт блокировку строк заданий; берём её сами и в порядке, в
        // котором их блокирует перестановка списка в панели (`sort, id`), — иначе взаимная блокировка.
        await tx.$queryRaw`SELECT task_id FROM task_def WHERE period = 'achievement' AND category IS NOT NULL ORDER BY sort, task_id FOR KEY SHARE`;
        await tx.$executeRaw`DELETE FROM achievement_rarity`;
        if (rows.length > 0) {
          await tx.$executeRaw`
            INSERT INTO achievement_rarity (task_id, holders, population, computed_at)
            SELECT u.task_id, u.holders, u.population, ${now}::timestamptz
            FROM unnest(${rows.map((row) => row.task_id)}::text[], ${rows.map((row) => row.holders)}::int[], ${rows.map((row) => row.population)}::int[]) AS u(task_id, holders, population)`;
        }
        return { rows: rows.length, population: rows[0]?.population ?? 0, computedAt: now };
      },
      { maxWait: 5_000, timeout: RARITY_QUERY_TIMEOUT_MS + 30_000 },
    );
  }
}
