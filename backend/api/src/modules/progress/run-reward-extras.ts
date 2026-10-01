import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { RunExtras, type RunRewardPart, type RunRewardSource } from "../runs/run-details.js";
import { PROGRESS_REPOSITORY, type ProgressRepository } from "./progress.repository.js";

/**
 * Награда за забег в листе забега (docs/35-stage4-plan.md, WP4): подключается
 * к модулю забегов сама, как сверка бустов у модуля бустов.
 */
@Injectable()
export class RunRewardExtras implements RunRewardSource, OnModuleInit {
  constructor(
    @Inject(PROGRESS_REPOSITORY) private readonly progress: ProgressRepository,
    private readonly extras: RunExtras,
  ) {}

  onModuleInit(): void {
    this.extras.provideReward(this);
  }

  async reward(accountId: string, runId: string): Promise<RunRewardPart> {
    const row = await this.progress.reward(runId, accountId);
    if (row === null || (row.skipped === null && row.coinsCredited === null)) {
      return { status: "pending", reason: null, coins: 0, xp: 0, levelBefore: 0, levelAfter: 0 };
    }
    if (row.skipped !== null) return { status: "none", reason: row.skipped, coins: 0, xp: 0, levelBefore: row.levelBefore, levelAfter: row.levelAfter };
    // Монеты — сколько легло на счёт после потолка суток, а не сколько посчитано.
    return { status: "granted", reason: null, coins: row.coinsCredited ?? 0, xp: row.xp, levelBefore: row.levelBefore, levelAfter: row.levelAfter };
  }
}
