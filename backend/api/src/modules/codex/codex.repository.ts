import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Хранилище кодекса врагов (tasks/T-0127): одна строка на пару «аккаунт —
 * враг», открытая запись не закрывается и не переписывается. Оба запроса идут
 * по первичному ключу `(account_id, enemy_id)`.
 */

export interface CodexEntry {
  enemyId: string;
  firstSeenAt: Date;
}

export const CODEX_REPOSITORY = Symbol("CODEX_REPOSITORY");

export interface CodexRepository {
  /** Все открытые записи аккаунта одним запросом. */
  opened(accountId: string): Promise<CodexEntry[]>;
  /**
   * Открыть записи; уже открытые не трогаются, их `first_seen_at` остаётся.
   * Возвращает id, открытые именно этим вызовом: два забега разом не откроют
   * одно и то же дважды.
   */
  open(accountId: string, enemyIds: readonly string[], at: Date): Promise<string[]>;
}

const entrySchema = z.object({ enemy_id: z.string(), first_seen_at: z.date() });
const insertedSchema = z.object({ enemy_id: z.string() });

@Injectable()
export class PrismaCodexRepository implements CodexRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async opened(accountId: string): Promise<CodexEntry[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT enemy_id, first_seen_at FROM codex_entry WHERE account_id = ${accountId}::uuid ORDER BY enemy_id`;
    return rows.map((row) => {
      const parsed = entrySchema.parse(row);
      return { enemyId: parsed.enemy_id, firstSeenAt: parsed.first_seen_at };
    });
  }

  async open(accountId: string, enemyIds: readonly string[], at: Date): Promise<string[]> {
    if (enemyIds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<unknown[]>`
      INSERT INTO codex_entry (account_id, enemy_id, first_seen_at)
      SELECT ${accountId}::uuid, e, ${at} FROM unnest(${[...enemyIds]}::text[]) AS e
      ON CONFLICT (account_id, enemy_id) DO NOTHING
      RETURNING enemy_id`;
    return rows.map((row) => insertedSchema.parse(row).enemy_id);
  }
}
