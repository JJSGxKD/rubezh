import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Строка компенсации тестеру (`tester_compensation`, tasks/T-0040): её пишет
 * снимок перед вайпом, выдача (`compensation.service.ts`) читает и отмечает
 * «забрано». `grants` отдаётся как есть, неразобранным: JSON из базы разбирает
 * сервис схемой `compensationGrantsSchema`, а не приводит.
 */
export interface CompensationRow {
  accountId: string;
  /** играл до вайпа: знак и бонус */
  tester: boolean;
  level: number;
  bonusGems: number;
  grants: unknown;
  /** звёзды, списанные за второй шанс, — выдача переводит их в самоцветы по курсу */
  continueStars: number;
  claimedAt: Date | null;
}

export const COMPENSATION_REPOSITORY = Symbol("COMPENSATION_REPOSITORY");

export interface CompensationRepository {
  find(accountId: string): Promise<CompensationRow | null>;
  /** `false` — уже отмечено раньше */
  markClaimed(accountId: string, at: Date): Promise<boolean>;
}

@Injectable()
export class PrismaCompensationRepository implements CompensationRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async find(accountId: string): Promise<CompensationRow | null> {
    const row = await this.prisma.testerCompensation.findUnique({
      where: { accountId },
      select: { accountId: true, tester: true, level: true, bonusGems: true, grants: true, continueStars: true, claimedAt: true },
    });
    return row;
  }

  async markClaimed(accountId: string, at: Date): Promise<boolean> {
    // Условный UPDATE: из двух одновременных нажатий отметка уйдёт только одному.
    const marked = await this.prisma.testerCompensation.updateMany({ where: { accountId, claimedAt: null }, data: { claimedAt: at } });
    return marked.count === 1;
  }
}
