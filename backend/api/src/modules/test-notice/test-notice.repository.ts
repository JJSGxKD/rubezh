import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Принятие предупреждения об открытом тесте (`test_notice`, docs/35-stage4-plan.md
 * WP33): строка на аккаунт. Первое принятие не переписывается — по нему
 * проверяется, что игрок видел предупреждение до первой покупки; версия и
 * время её принятия растут вместе с текстом.
 */

export interface TestNoticeAcceptance {
  /** последняя принятая версия текста */
  version: number;
  /** когда принята эта версия */
  acceptedAt: Date;
  /** когда игрок впервые принял предупреждение — любой версии */
  firstAcceptedAt: Date;
}

export const TEST_NOTICE_REPOSITORY = Symbol("TEST_NOTICE_REPOSITORY");

export interface TestNoticeRepository {
  find(accountId: string): Promise<TestNoticeAcceptance | null>;
  /** принять версию; старая версия после новой ничего не меняет */
  accept(accountId: string, version: number, at: Date): Promise<TestNoticeAcceptance>;
}

const rowSchema = z.object({ version: z.number().int(), accepted_at: z.date(), first_accepted_at: z.date() });

function toAcceptance(raw: unknown): TestNoticeAcceptance {
  const row = rowSchema.parse(raw);
  return { version: row.version, acceptedAt: row.accepted_at, firstAcceptedAt: row.first_accepted_at };
}

@Injectable()
export class PrismaTestNoticeRepository implements TestNoticeRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async find(accountId: string): Promise<TestNoticeAcceptance | null> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT version, accepted_at, first_accepted_at FROM test_notice WHERE account_id = ${accountId}::uuid`;
    return rows.length === 0 ? null : toAcceptance(rows[0]);
  }

  async accept(accountId: string, version: number, at: Date): Promise<TestNoticeAcceptance> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      INSERT INTO test_notice (account_id, version, accepted_at, first_accepted_at)
      VALUES (${accountId}::uuid, ${version}::int, ${at}, ${at})
      ON CONFLICT (account_id) DO UPDATE SET
        version = GREATEST(test_notice.version, EXCLUDED.version),
        accepted_at = CASE WHEN EXCLUDED.version > test_notice.version THEN EXCLUDED.accepted_at ELSE test_notice.accepted_at END
      RETURNING version, accepted_at, first_accepted_at`;
    return toAcceptance(rows[0]);
  }
}
