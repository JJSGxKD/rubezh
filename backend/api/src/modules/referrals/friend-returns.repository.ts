import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Возвращения (docs/35-stage4-plan.md §3.8): вернувшийся по ссылке друга ждёт
 * своего забега, после него награда обоим. Ключ — пара и номер периода.
 */

export interface PendingReturn {
  friendId: string;
  period: number;
}

export const FRIEND_RETURNS_REPOSITORY = Symbol("FRIEND_RETURNS_REPOSITORY");

export interface FriendReturnsRepository {
  /** Отметить возвращение; `false` — в этом периоде пару уже отмечали. */
  record(returnedId: string, friendId: string, period: number, at: Date): Promise<boolean>;
  /** Ненагражденные возвращения игрока не раньше `since`. */
  pending(returnedId: string, since: Date): Promise<PendingReturn[]>;
  /** Пометить награждённым; `false` — уже помечено: награда не удвоится. */
  markRewarded(returnedId: string, friendId: string, period: number, at: Date): Promise<boolean>;
}

@Injectable()
export class PrismaFriendReturnsRepository implements FriendReturnsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async record(returnedId: string, friendId: string, period: number, at: Date): Promise<boolean> {
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO friend_return (returned_account_id, friend_account_id, period, returned_at)
      VALUES (${returnedId}::uuid, ${friendId}::uuid, ${period}, ${at})
      ON CONFLICT DO NOTHING`;
    return inserted > 0;
  }

  async pending(returnedId: string, since: Date): Promise<PendingReturn[]> {
    return await this.prisma.friendReturn.findMany({
      where: { returnedId, rewardedAt: null, returnedAt: { gte: since } },
      select: { friendId: true, period: true },
      orderBy: { returnedAt: "asc" },
    });
  }

  async markRewarded(returnedId: string, friendId: string, period: number, at: Date): Promise<boolean> {
    const { count } = await this.prisma.friendReturn.updateMany({ where: { returnedId, friendId, period, rewardedAt: null }, data: { rewardedAt: at } });
    return count > 0;
  }
}
