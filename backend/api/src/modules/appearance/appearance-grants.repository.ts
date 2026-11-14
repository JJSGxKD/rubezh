import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Выданные облики (docs/35-stage4-plan.md Р155, tasks/T-0245): облик, выданный разово, а не
 * вычисленный по состоянию аккаунта, — купленный в наборе магазина, позже подаренный или
 * полученный в пассе. Хранится строкой `appearance_grant` с ключом `(аккаунт, облик)`; всё
 * остальное владение сервер по-прежнему считает при чтении (`appearance-rules.ts`).
 *
 * Чтение берёт список аккаунтов целиком одним запросом — рейтинг, сезон и друзья спрашивают
 * облики пачкой, а не по строке.
 */

/** Как облик получен. Остальные источники приходят со своими задачами и дописываются сюда же. */
export type AppearanceGrantSource = "purchase";

export interface AppearanceGrantInput {
  accountId: string;
  appearanceId: string;
  source: AppearanceGrantSource;
  /** покупка, за которую выдан облик; у `purchase` обязательна — это держит и база */
  purchaseId: string | null;
  grantedAt: Date;
}

export const APPEARANCE_GRANTS_REPOSITORY = Symbol("APPEARANCE_GRANTS_REPOSITORY");

export interface AppearanceGrantsRepository {
  /** Какие облики выданы каждому из аккаунтов; у аккаунта без выдач записи нет. */
  held(accountIds: readonly string[]): Promise<Map<string, Set<string>>>;
  /**
   * Выдать облик. Повтор — `false` и ни одной записи: у аккаунта облик один, и повтор
   * подтверждения оплаты ничего не меняет. `true` — строка заведена этим вызовом.
   */
  grant(input: AppearanceGrantInput): Promise<boolean>;
  /** Снять облики, выданные за покупку (возврат); возвращает снятые id. Повтор — пустой список. */
  revokeByPurchase(purchaseId: string): Promise<string[]>;
}

const heldSchema = z.object({ account_id: z.string(), appearance_id: z.string() });
const revokedSchema = z.object({ appearance_id: z.string() });

@Injectable()
export class PrismaAppearanceGrantsRepository implements AppearanceGrantsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async held(accountIds: readonly string[]): Promise<Map<string, Set<string>>> {
    const result = new Map<string, Set<string>>();
    if (accountIds.length === 0) return result;
    const rows = await this.prisma.$queryRaw<unknown[]>`
      SELECT account_id::text AS account_id, appearance_id
      FROM appearance_grant
      WHERE account_id = ANY(${[...accountIds]}::uuid[])`;
    for (const raw of rows) {
      const row = heldSchema.parse(raw);
      const held = result.get(row.account_id) ?? new Set<string>();
      held.add(row.appearance_id);
      result.set(row.account_id, held);
    }
    return result;
  }

  async grant(input: AppearanceGrantInput): Promise<boolean> {
    // Повтор решает ключ строки, а не чтение перед записью: два задания выдачи разом дают одну строку.
    const created = await this.prisma.$executeRaw`
      INSERT INTO appearance_grant (account_id, appearance_id, source, purchase_id, granted_at)
      VALUES (${input.accountId}::uuid, ${input.appearanceId}, ${input.source}, ${input.purchaseId}::uuid, ${input.grantedAt})
      ON CONFLICT (account_id, appearance_id) DO NOTHING`;
    return created > 0;
  }

  async revokeByPurchase(purchaseId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<unknown[]>`
      DELETE FROM appearance_grant WHERE purchase_id = ${purchaseId}::uuid RETURNING appearance_id`;
    return rows.map((raw) => revokedSchema.parse(raw).appearance_id).sort();
  }
}

/** Без выдач — тесты и сборки, где базы нет: облики считаются только по состоянию аккаунта. */
export const NO_APPEARANCE_GRANTS: AppearanceGrantsRepository = {
  held: async () => new Map<string, Set<string>>(),
  grant: async () => false,
  revokeByPurchase: async () => [],
};
