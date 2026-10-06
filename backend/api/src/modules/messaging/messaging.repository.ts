import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Можно ли писать игроку (docs/35-stage4-plan.md, §3.10). Одна строка на
 * аккаунт; состояние меняют обновления площадки, а не слова клиента.
 */

export type MessagingReason = "entered" | "write_access" | "blocked" | "unblocked";

export interface MessagingState {
  canMessage: boolean;
  reason: MessagingReason;
  changedAt: Date;
}

export const MESSAGING_REPOSITORY = Symbol("MESSAGING_REPOSITORY");

export interface MessagingRepository {
  /** Записать состояние, если оно не старше записанного: обновления площадки приходят не по порядку. */
  set(accountId: string, state: MessagingState): Promise<void>;
  get(accountId: string): Promise<MessagingState | null>;
}

@Injectable()
export class PrismaMessagingRepository implements MessagingRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async set(accountId: string, state: MessagingState): Promise<void> {
    // Блокировка, пришедшая раньше старого «/start» из очереди, не должна
    // снова открыть игрока для рассылок: побеждает более позднее событие.
    await this.prisma.$executeRaw`
      INSERT INTO account_messaging (account_id, can_message, reason, changed_at)
      VALUES (${accountId}::uuid, ${state.canMessage}, ${state.reason}::"MessagingReason", ${state.changedAt})
      ON CONFLICT (account_id) DO UPDATE SET
        can_message = EXCLUDED.can_message,
        reason = EXCLUDED.reason,
        changed_at = EXCLUDED.changed_at
      WHERE account_messaging.changed_at <= EXCLUDED.changed_at
    `;
  }

  async get(accountId: string): Promise<MessagingState | null> {
    const row = await this.prisma.accountMessaging.findUnique({ where: { accountId } });
    return row === null ? null : { canMessage: row.canMessage, reason: row.reason, changedAt: row.changedAt };
  }
}
