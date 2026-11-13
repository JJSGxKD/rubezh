import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { PLATFORM_IDS, type PlatformId } from "../../platforms/ports/platform.js";
import type { LinkOutcome } from "./external-identity-rules.js";

/**
 * Связи аккаунтов игры с аккаунтами MAX и VK в базе (`external_identity`,
 * docs/35-stage4-plan.md Р188, tasks/T-0377). Запись — один `INSERT … ON
 * CONFLICT DO NOTHING`: «один id площадки — один аккаунт» и «одна связь на
 * площадку» держат уникальный индекс и первичный ключ, а не проверка до
 * записи, которую обошли бы два бота разом.
 */

export const EXTERNAL_IDENTITY_REPOSITORY = Symbol("EXTERNAL_IDENTITY_REPOSITORY");

export interface ExternalIdentityRow {
  accountId: string;
  platform: PlatformId;
  externalUserId: string;
  linkedAt: Date;
}

/** Исходы записи пары; `missing` — аккаунта в базе нет (его удалили, пока код ждал бота). */
export type LinkResult = LinkOutcome | "missing";

export interface ExternalIdentityRepository {
  find(accountId: string, platform: PlatformId): Promise<ExternalIdentityRow | null>;
  /**
   * Закрепить пару за аккаунтом. `linked` — записана этим вызовом; `already` —
   * та же пара уже была; `taken` — id площадки занят другим аккаунтом или у
   * аккаунта на этой площадке другая связь. Связь не меняется и не снимается.
   */
  link(accountId: string, platform: PlatformId, externalUserId: string): Promise<LinkResult>;
}

const rowSchema = z.object({
  account_id: z.string(),
  platform: z.enum(PLATFORM_IDS),
  external_user_id: z.string(),
  linked_at: z.date(),
});

const ownerSchema = z.object({ account_id: z.string(), external_user_id: z.string() });

@Injectable()
export class PrismaExternalIdentityRepository implements ExternalIdentityRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async find(accountId: string, platform: PlatformId): Promise<ExternalIdentityRow | null> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT account_id::text AS account_id, platform::text AS platform, external_user_id, linked_at
      FROM external_identity
      WHERE account_id = ${accountId}::uuid AND platform = ${platform}::"Platform"`;
    const row = rows[0];
    if (row === undefined) return null;
    const parsed = rowSchema.parse(row);
    return { accountId: parsed.account_id, platform: parsed.platform, externalUserId: parsed.external_user_id, linkedAt: parsed.linked_at };
  }

  async link(accountId: string, platform: PlatformId, externalUserId: string): Promise<LinkResult> {
    // Вставка из `account`, а не значениями: аккаунта нет — вставлять нечего, и это не ошибка внешнего ключа.
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO external_identity (account_id, platform, external_user_id)
      SELECT account_id, ${platform}::"Platform", ${externalUserId} FROM account WHERE account_id = ${accountId}::uuid
      ON CONFLICT DO NOTHING`;
    if (inserted > 0) return "linked";
    // Не вставилось: пара или связь аккаунта уже заняты. Кто владеет, читается после вставки, а не до неё.
    const owners = await this.prisma.$queryRaw<unknown[]>`
      SELECT account_id::text AS account_id, external_user_id
      FROM external_identity
      WHERE platform = ${platform}::"Platform"
        AND (account_id = ${accountId}::uuid OR external_user_id = ${externalUserId})`;
    if (owners.length === 0) return "missing";
    const same = owners.some((raw) => {
      const owner = ownerSchema.parse(raw);
      return owner.account_id === accountId && owner.external_user_id === externalUserId;
    });
    return same ? "already" : "taken";
  }
}
