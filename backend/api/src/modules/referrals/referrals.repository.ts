import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { GAME_DAY_TIME_ZONE } from "../../common/game-day.js";
import { PRISMA } from "../../infra/database.js";

/** Привязки рефералов (docs/23-referral-and-partner-program.md §2): одна на приглашённого и навсегда. */

export type ReferralStatus = "bound" | "activated" | "rejected";

export interface ReferralBinding {
  referredId: string;
  referrerId: string;
  status: ReferralStatus;
  boundAt: Date;
  activatedAt: Date | null;
  rejectReason: string | null;
}

export interface ReferralRow extends ReferralBinding {
  displayName: string;
  photoUrl: string | null;
}

export const REFERRALS_REPOSITORY = Symbol("REFERRALS_REPOSITORY");

export interface ReferralsRepository {
  binding(referredId: string): Promise<ReferralBinding | null>;
  /** Привязать; `false` — привязка уже была: одна и навсегда. */
  bind(referredId: string, referrerId: string, status: "bound" | "rejected", rejectReason: string | null): Promise<boolean>;
  /** Активировать; `false` — уже активирована или не в статусе ожидания: награда не удвоится. */
  activate(referredId: string, at: Date): Promise<boolean>;
  /** Сколько приглашённых пригласившего активировано за текущие игровые сутки. */
  activatedToday(referrerId: string): Promise<number>;
  byReferrer(referrerId: string, limit: number): Promise<ReferralRow[]>;
}

@Injectable()
export class PrismaReferralsRepository implements ReferralsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async binding(referredId: string): Promise<ReferralBinding | null> {
    return await this.prisma.referralBinding.findUnique({ where: { referredId } });
  }

  async bind(referredId: string, referrerId: string, status: "bound" | "rejected", rejectReason: string | null): Promise<boolean> {
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO referral_binding (referred_account_id, referrer_account_id, status, reject_reason)
      VALUES (${referredId}::uuid, ${referrerId}::uuid, ${status}::"ReferralStatus", ${rejectReason})
      ON CONFLICT DO NOTHING`;
    return inserted > 0;
  }

  async activate(referredId: string, at: Date): Promise<boolean> {
    const { count } = await this.prisma.referralBinding.updateMany({ where: { referredId, status: "bound" }, data: { status: "activated", activatedAt: at } });
    return count > 0;
  }

  async activatedToday(referrerId: string): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM referral_binding
      WHERE referrer_account_id = ${referrerId}::uuid AND status = 'activated'
        AND (activated_at AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date = (now() AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date`;
    return row?.count ?? 0;
  }

  async byReferrer(referrerId: string, limit: number): Promise<ReferralRow[]> {
    const rows = await this.prisma.referralBinding.findMany({
      where: { referrerId, status: { not: "rejected" } },
      include: { referred: { select: { displayName: true, photoUrl: true } } },
      orderBy: { boundAt: "desc" },
      take: limit,
    });
    return rows.map(({ referred, ...binding }) => ({ ...binding, ...referred }));
  }
}

