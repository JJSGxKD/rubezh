import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { levelForXp } from "./progress-rules.js";

/**
 * Опыт аккаунта и награды за забег (docs/35-stage4-plan.md, WP4).
 *
 * Строка награды и прибавка опыта — одна транзакция: строка вставляется
 * `ON CONFLICT DO NOTHING`, и только если вставилась, опыт растёт. Повтор
 * задания очереди — та же строка, и опыт не удваивается; монеты начисляет
 * кошелёк по своему ключу, отдельно и тоже без удвоения.
 */

export interface RunRewardInput {
  runId: string;
  accountId: string;
  coins: number;
  xp: number;
  skipped: string | null;
  at: Date;
}

export interface RunRewardRow {
  runId: string;
  accountId: string;
  coins: number;
  coinsCredited: number | null;
  xp: number;
  levelBefore: number;
  levelAfter: number;
  skipped: string | null;
}

export interface Progress {
  xp: number;
  level: number;
}

export const PROGRESS_REPOSITORY = Symbol("PROGRESS_REPOSITORY");

export interface ProgressRepository {
  /** записать награду и прибавить опыт; повтор отдаёт прежнюю строку, ничего не меняя */
  recordRun(input: RunRewardInput): Promise<RunRewardRow>;
  /** монеты легли в кошелёк — сколько на самом деле, после потолка суток */
  markCredited(runId: string, coinsCredited: number): Promise<void>;
  reward(runId: string, accountId: string): Promise<RunRewardRow | null>;
  progress(accountId: string): Promise<Progress>;
}

const SELECT = {
  runId: true,
  accountId: true,
  coins: true,
  coinsCredited: true,
  xp: true,
  levelBefore: true,
  levelAfter: true,
  skipped: true,
} as const;

@Injectable()
export class PrismaProgressRepository implements ProgressRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async recordRun(input: RunRewardInput): Promise<RunRewardRow> {
    return await this.prisma.$transaction(
      async (tx) => {
        // Строка прогресса блокируется до конца транзакции: две награды одного
        // игрока, пришедшие разом, не прочитают один и тот же опыт.
        await tx.$executeRaw`
          INSERT INTO account_progress (account_id, xp, level, updated_at) VALUES (${input.accountId}::uuid, 0, 1, ${input.at})
          ON CONFLICT (account_id) DO NOTHING
        `;
        const [current] = await tx.$queryRaw<{ xp: bigint; level: number }[]>`
          SELECT xp, level FROM account_progress WHERE account_id = ${input.accountId}::uuid FOR UPDATE
        `;
        const before = { xp: Number(current?.xp ?? 0n), level: current?.level ?? 1 };
        const after = { xp: before.xp + input.xp, level: levelForXp(before.xp + input.xp) };

        const inserted = await tx.runReward.createMany({
          data: [
            {
              runId: input.runId,
              accountId: input.accountId,
              coins: input.coins,
              xp: input.xp,
              levelBefore: before.level,
              levelAfter: after.level,
              skipped: input.skipped,
              createdAt: input.at,
            },
          ],
          skipDuplicates: true,
        });
        if (inserted.count === 0) return await tx.runReward.findUniqueOrThrow({ where: { runId: input.runId }, select: SELECT });

        if (input.xp > 0) {
          await tx.accountProgress.update({ where: { accountId: input.accountId }, data: { xp: after.xp, level: after.level, updatedAt: input.at } });
        }
        return {
          runId: input.runId,
          accountId: input.accountId,
          coins: input.coins,
          coinsCredited: null,
          xp: input.xp,
          levelBefore: before.level,
          levelAfter: after.level,
          skipped: input.skipped,
        };
      },
      { maxWait: 5_000, timeout: 10_000 },
    );
  }

  async markCredited(runId: string, coinsCredited: number): Promise<void> {
    await this.prisma.runReward.update({ where: { runId }, data: { coinsCredited } });
  }

  async reward(runId: string, accountId: string): Promise<RunRewardRow | null> {
    // Чужую награду не отдаём: забег принадлежит аккаунту, и идентификатор
    // забега — не пропуск к чужим числам.
    return await this.prisma.runReward.findFirst({ where: { runId, accountId }, select: SELECT });
  }

  async progress(accountId: string): Promise<Progress> {
    const row = await this.prisma.accountProgress.findUnique({ where: { accountId }, select: { xp: true, level: true } });
    return { xp: Number(row?.xp ?? 0n), level: row?.level ?? 1 };
  }
}
