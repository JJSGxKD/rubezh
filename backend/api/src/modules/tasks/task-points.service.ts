import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import type { AccountRef } from "../roles/roles.service.js";
import { WalletService } from "../wallet/wallet.service.js";
import type { WalletResource } from "../wallet/wallet-types.js";
import { pointsView, stepOf, type PointsPeriod, type PointsReward, type PointsView } from "./task-points.js";
import { TASK_POINTS_REPOSITORY, type TaskPointsRepository } from "./task-points.repository.js";
import { TaskPointsNotReachedError, TaskPointsStepNotFoundError } from "./tasks-errors.js";

/**
 * Очки заданий (docs/39-retention-mechanics.md П2, tasks/T-0105): полоса дня и
 * недели и награды за ступени. Забор устроен как у награды задания: начисление
 * с ключом срока и порога, потом отметка в `task_points_claim`. Два запроса
 * разом начисляют однажды: второй упирается в ключ кошелька и в отметку, а
 * начисленное, но не отмеченное после сбоя кошелёк узнает по ключу.
 *
 * Награда идёт причиной `task_reward`, как награда самих заданий: потолок
 * кошелька у неё общий, и он режет награду — `credited` возвращает, сколько
 * легло на баланс.
 */

const DB_TIMEOUT_MS = 3_000;

export interface PointsClaimResult {
  claimed: boolean;
  /** сколько легло на баланс; меньше награды — упёрлось в суточный потолок */
  credited: PointsReward;
  points: number;
}

/** Ресурс награды в кошельке: осколки заданий — обычные. */
const REWARD_RESOURCES = [
  ["coins", "coins"],
  ["gems", "gems"],
  ["shards", "shard_common"],
] as const satisfies readonly (readonly [keyof PointsReward, WalletResource])[];

@Injectable()
export class TaskPointsService {
  private readonly logger = new Logger("tasks");

  constructor(
    @Inject(TASK_POINTS_REPOSITORY) private readonly repository: TaskPointsRepository,
    private readonly wallet: WalletService,
  ) {}

  async view(accountId: string, at = new Date()): Promise<PointsView> {
    const totals = await this.db(this.repository.totals(accountId, at));
    const claims = await this.db(this.repository.claims(accountId, totals.dayStart, totals.weekStart));
    return pointsView({ daily: totals.daily, weekly: totals.weekly }, claims);
  }

  async claim(account: AccountRef, period: PointsPeriod, points: number, at = new Date()): Promise<PointsClaimResult> {
    const { accountId } = account;
    const step = stepOf(period, points);
    if (step === undefined) throw new TaskPointsStepNotFoundError();

    const totals = await this.db(this.repository.totals(accountId, at));
    const claims = await this.db(this.repository.claims(accountId, totals.dayStart, totals.weekStart));
    const none: PointsReward = { coins: 0, gems: 0, shards: 0 };
    // Забранная остаётся забранной, даже если очки потом убыли (задание выключили).
    if (claims[period].has(points)) return { claimed: false, credited: none, points };
    if (totals[period] < points) throw new TaskPointsNotReachedError();

    const periodStart = period === "daily" ? totals.dayStart : totals.weekStart;
    const credited = { ...none };
    for (const [field, resource] of REWARD_RESOURCES) {
      if (step.reward[field] <= 0) continue;
      const result = await this.db(
        this.wallet.grant({
          accountId,
          resource,
          amount: step.reward[field],
          reason: "task_reward",
          source: `task_points:${period}:${String(points)}`,
          idempotencyKey: `task_points:${accountId}:${period}:${periodStart}:${String(points)}:${resource}`,
          at,
        }),
      );
      credited[field] = result.credited;
    }
    const claimed = await this.db(this.repository.markClaimed({ accountId, period, periodStart, points, at }));
    // Проигравший гонку видит ту же награду в кошельке по ключу, но получил её не он.
    if (!claimed) return { claimed: false, credited: none, points };
    this.logger.log(JSON.stringify({ module: "tasks", event: "task_points_claimed", accountId, period, points, ...credited }));
    return { claimed: true, credited, points };
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "очки заданий");
  }
}
