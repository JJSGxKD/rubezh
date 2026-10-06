import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { AccountSettingValues } from "./account-settings.catalog.js";

/** Настройки аккаунта в базе (`account_settings`) — одна строка на аккаунт. */

export interface StoredAccountSettings {
  version: number;
  /** JSON как есть — разбирает `readStored` */
  values: unknown;
}

export const ACCOUNT_SETTINGS_REPOSITORY = Symbol("ACCOUNT_SETTINGS_REPOSITORY");

export interface AccountSettingsRepository {
  get(accountId: string): Promise<StoredAccountSettings | null>;
  /**
   * Прочитать, слить и записать под блокировкой строки: два устройства,
   * приславшие настройки одновременно, иначе затёрли бы друг друга.
   */
  update(accountId: string, merge: (current: StoredAccountSettings | null) => { version: number; values: AccountSettingValues }): Promise<{ version: number; values: AccountSettingValues }>;
}

const rowSchema = z.array(z.object({ version: z.number().int(), values: z.unknown() }));

@Injectable()
export class PrismaAccountSettingsRepository implements AccountSettingsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async get(accountId: string): Promise<StoredAccountSettings | null> {
    const row = await this.prisma.accountSettings.findUnique({ where: { accountId }, select: { version: true, values: true } });
    return row === null ? null : { version: row.version, values: row.values };
  }

  async update(accountId: string, merge: (current: StoredAccountSettings | null) => { version: number; values: AccountSettingValues }): Promise<{ version: number; values: AccountSettingValues }> {
    return await this.prisma.$transaction(async (tx) => {
      // Строки ещё нет у первого приславшего: завести пустую, чтобы было что
      // заблокировать, — второй дождётся первого на блокировке.
      await tx.$executeRaw`
        INSERT INTO account_settings (account_id, version, values, updated_at)
        VALUES (${accountId}::uuid, 0, '{}'::jsonb, now())
        ON CONFLICT (account_id) DO NOTHING`;
      const [current] = rowSchema.parse(await tx.$queryRaw`SELECT version, values FROM account_settings WHERE account_id = ${accountId}::uuid FOR UPDATE`);
      const next = merge(current === undefined || current.version === 0 ? null : current);
      await tx.accountSettings.update({ where: { accountId }, data: { version: next.version, values: next.values } });
      return next;
    });
  }
}
