import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Хранилище кодекса тайников (tasks/T-0261): одна строка на пару «аккаунт —
 * вид», найденное не закрывается и не переписывается. Оба запроса идут по
 * первичному ключу `(account_id, kind)`.
 */

export interface SecretFoundEntry {
  kind: string;
  firstAt: Date;
}

export const SECRETS_CODEX_REPOSITORY = Symbol("SECRETS_CODEX_REPOSITORY");

export interface SecretsCodexRepository {
  /** Все найденные виды аккаунта одним запросом. */
  found(accountId: string): Promise<SecretFoundEntry[]>;
  /**
   * Записать виды; уже найденные не трогаются, их `first_at` остаётся.
   * Возвращает виды, записанные именно этим вызовом: два забега разом не
   * запишут один и тот же вид дважды.
   */
  record(accountId: string, kinds: readonly string[], at: Date): Promise<string[]>;
}

const entrySchema = z.object({ kind: z.string(), first_at: z.date() });
const insertedSchema = z.object({ kind: z.string() });

@Injectable()
export class PrismaSecretsCodexRepository implements SecretsCodexRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async found(accountId: string): Promise<SecretFoundEntry[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT kind, first_at FROM secret_found WHERE account_id = ${accountId}::uuid ORDER BY kind`;
    return rows.map((row) => {
      const parsed = entrySchema.parse(row);
      return { kind: parsed.kind, firstAt: parsed.first_at };
    });
  }

  async record(accountId: string, kinds: readonly string[], at: Date): Promise<string[]> {
    if (kinds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<unknown[]>`
      INSERT INTO secret_found (account_id, kind, first_at)
      SELECT ${accountId}::uuid, k, ${at} FROM unnest(${[...kinds]}::text[]) AS k
      ON CONFLICT (account_id, kind) DO NOTHING
      RETURNING kind`;
    return rows.map((row) => insertedSchema.parse(row).kind);
  }
}
