import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Ленты месяцев для панели (tasks/T-0313): список, чтение, заведение, правка и
 * публикация. Сырой SQL, как у остального пасса: каждая запись — одна команда.
 *
 * **Черновик — это `published_at = 'infinity'`.** Колонка обязательна (миграция
 * T-0311), а новой миграции задача не вводит: «ещё не опубликована» хранится
 * как бесконечность. Игрок читает `published_at <= <сейчас>`
 * (`BattlePassRepository.season`), и черновик ему не виден; сама бесконечность в
 * приложение не читается — наружу идёт только «опубликована ли» и момент публикации.
 */

export interface PassSeasonRecord {
  /** лента как лежит в базе: непроверенный `jsonb` */
  tiers: unknown;
  published: boolean;
  publishedAt: Date | null;
}

export interface PassSeasonListed {
  monthKey: string;
  published: boolean;
}

export const PASS_SEASON_REPOSITORY = Symbol("PASS_SEASON_REPOSITORY");

export interface PassSeasonRepository {
  /** Все заведённые месяцы, свежие первыми. */
  list(): Promise<PassSeasonListed[]>;
  find(monthKey: string): Promise<PassSeasonRecord | null>;
  /** Завести черновик; `false` — месяц уже есть, ничего не записано. */
  insertDraft(monthKey: string, tiers: unknown): Promise<boolean>;
  /**
   * Заменить ленту, только если она всё ещё такая, как её прочли: правка двух
   * администраторов не затирает друг друга молча. `false` — лента изменилась или месяца нет.
   */
  replaceTiers(monthKey: string, before: unknown, after: unknown): Promise<boolean>;
  /** Опубликовать черновик; `false` — месяца нет или он уже опубликован. */
  publish(monthKey: string, at: Date): Promise<boolean>;
  /** Наибольшие очки среди игроков месяца: по ним видно, до какой ступени кто-то дошёл. */
  maxPoints(monthKey: string): Promise<number>;
}

const listedSchema = z.object({ month_key: z.string(), published: z.boolean() });
const recordSchema = z.object({ tiers: z.unknown(), published: z.boolean(), published_at: z.date().nullable() });
const maxSchema = z.object({ points: z.number().int() });

/** Предел списка: прошлые месяцы копятся по двенадцать в год — за десять лет хватит с запасом. */
const LIST_LIMIT = 120;

@Injectable()
export class PrismaPassSeasonRepository implements PassSeasonRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(): Promise<PassSeasonListed[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT month_key, (published_at < 'infinity'::timestamptz) AS published
      FROM pass_season ORDER BY month_key DESC LIMIT ${LIST_LIMIT}`;
    return rows.map((raw) => listedSchema.parse(raw)).map((row) => ({ monthKey: row.month_key, published: row.published }));
  }

  async find(monthKey: string): Promise<PassSeasonRecord | null> {
    const [row] = await this.prisma.$queryRaw<unknown[]>`
      SELECT tiers, (published_at < 'infinity'::timestamptz) AS published,
             CASE WHEN published_at < 'infinity'::timestamptz THEN published_at END AS published_at
      FROM pass_season WHERE month_key = ${monthKey}`;
    if (row === undefined) return null;
    const parsed = recordSchema.parse(row);
    return { tiers: parsed.tiers, published: parsed.published, publishedAt: parsed.published_at };
  }

  async insertDraft(monthKey: string, tiers: unknown): Promise<boolean> {
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO pass_season (month_key, tiers, published_at)
      VALUES (${monthKey}, ${JSON.stringify(tiers)}::jsonb, 'infinity'::timestamptz)
      ON CONFLICT (month_key) DO NOTHING`;
    return inserted > 0;
  }

  async replaceTiers(monthKey: string, before: unknown, after: unknown): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE pass_season SET tiers = ${JSON.stringify(after)}::jsonb
      WHERE month_key = ${monthKey} AND tiers = ${JSON.stringify(before)}::jsonb`;
    return updated > 0;
  }

  async publish(monthKey: string, at: Date): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE pass_season SET published_at = ${at}
      WHERE month_key = ${monthKey} AND published_at = 'infinity'::timestamptz`;
    return updated > 0;
  }

  async maxPoints(monthKey: string): Promise<number> {
    const [row] = await this.prisma.$queryRaw<unknown[]>`SELECT COALESCE(MAX(points), 0)::int AS points FROM pass_progress WHERE month_key = ${monthKey}`;
    return maxSchema.parse(row).points;
  }
}
