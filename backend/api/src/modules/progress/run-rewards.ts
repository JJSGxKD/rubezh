import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { createQueueConnection } from "../../infra/queues.js";
import { ItemsService } from "../items/items.service.js";
import { RunsHooks, type RecordedRun } from "../runs/runs-hooks.js";
import { WalletService } from "../wallet/wallet.service.js";
import { levelReward, runReward } from "./progress-rules.js";
import { PROGRESS_REPOSITORY, type ProgressRepository, type RunRewardRow } from "./progress.repository.js";

/**
 * Награды за забег (docs/35-stage4-plan.md, WP4, §3.1). Итог забега пишется
 * синхронно одной строкой, как раньше, а награда — задание очереди `rewards`
 * с ключом `run_id`: сотни итогов в минуту после поста в канале не ждут опыта,
 * монет и уровня.
 *
 * Задание безопасно повторять целиком: строка награды с опытом —
 * `ON CONFLICT` по `run_id`, монеты — ключ кошелька `run:<runId>:coins`,
 * награда за уровень — `level:<аккаунт>:<уровень>:<ресурс>`, добыча —
 * `loot:<runId>` в журнале предметов. Упало между опытом и монетами — повтор
 * найдёт строку и доначислит монеты по тому же ключу.
 *
 * Redis недоступен — награда считается сразу, тоже мимо ответа игроку:
 * терять монеты за честный забег хуже, чем на время сбоя нагрузить базу.
 */

const QUEUE_NAME = "rewards";
const ENQUEUE_TIMEOUT_MS = 2_000;
const JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: "exponential", delay: 2_000, jitter: 0.5 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
} as const;
/** Награда — три-четыре короткие транзакции; больше параллельности упрётся в пул базы. */
const WORKER_CONCURRENCY = 4;

export type RewardJob = Pick<RecordedRun, "runId" | "accountId" | "difficulty" | "survivalSec" | "enemiesKilled" | "level" | "cheats" | "verdict"> & { finishedAt: string };

@Injectable()
export class RunRewards implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("progress");
  private queue: Queue<RewardJob> | null = null;
  private worker: Worker<RewardJob> | null = null;
  private connections: Redis[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly runs: RunsHooks,
    @Inject(PROGRESS_REPOSITORY) private readonly progress: ProgressRepository,
    private readonly wallet: WalletService,
    private readonly items: ItemsService,
  ) {}

  onModuleInit(): void {
    if (this.config.auth.enabled) this.runs.onRecorded("progress", (run) => this.enqueue(run));
  }

  onApplicationBootstrap(): void {
    if (!this.config.auth.enabled) return;
    const producer = createQueueConnection(this.config, "producer");
    const consumer = createQueueConnection(this.config, "worker");
    this.connections = [producer, consumer];
    this.queue = new Queue(QUEUE_NAME, { connection: producer });
    this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), { connection: consumer, concurrency: WORKER_CONCURRENCY });
    this.worker.on("failed", (job, error) => {
      this.log("warn", "reward_failed", { runId: job?.data.runId, attempts: job?.attemptsMade ?? 0, reason: error.message });
    });
    this.worker.on("error", (error) => this.log("warn", "worker_error", { reason: error.message }));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of this.connections) connection.disconnect();
  }

  async enqueue(run: RecordedRun): Promise<void> {
    const job = jobOf(run);
    if (this.queue !== null) {
      try {
        // Двоеточие BullMQ в идентификаторах не пускает — это разделитель его ключей.
        await withTimeout(this.queue.add("reward", job, { jobId: `run-${run.runId}`, ...JOB_OPTIONS }), ENQUEUE_TIMEOUT_MS, "очередь наград");
        return;
      } catch (error: unknown) {
        this.log("warn", "enqueue_failed", { runId: run.runId, reason: reasonOf(error) });
      }
    }
    try {
      await this.grant(job);
    } catch (error: unknown) {
      this.log("error", "reward_lost", { runId: run.runId, accountId: run.accountId, reason: reasonOf(error) });
    }
  }

  /** Одно задание. Вынесено ради тестов: очередь вокруг — BullMQ. */
  async process(job: Pick<Job<RewardJob>, "data">): Promise<void> {
    await this.grant(job.data);
  }

  async grant(job: RewardJob): Promise<RunRewardRow> {
    const decision = runReward(job);
    const at = new Date(job.finishedAt);
    const row = await this.progress.recordRun({ runId: job.runId, accountId: job.accountId, coins: decision.coins, xp: decision.xp, skipped: decision.skipped, at });
    if (row.skipped !== null || row.coinsCredited !== null) return row;

    let credited = 0;
    if (row.coins > 0) {
      const result = await this.wallet.grant({
        accountId: row.accountId,
        resource: "coins",
        amount: row.coins,
        reason: "run_reward",
        source: `run:${row.runId}`,
        idempotencyKey: `run:${row.runId}:coins`,
        at,
      });
      credited = result.credited;
    }
    for (let level = row.levelBefore + 1; level <= row.levelAfter; level++) {
      const reward = levelReward(level);
      const grant = { accountId: row.accountId, reason: "level_reward" as const, source: `level:${level}`, at };
      if (reward.coins > 0) await this.wallet.grant({ ...grant, resource: "coins", amount: reward.coins, idempotencyKey: `level:${row.accountId}:${level}:coins` });
      if (reward.gems > 0) await this.wallet.grant({ ...grant, resource: "gems", amount: reward.gems, idempotencyKey: `level:${row.accountId}:${level}:gems` });
    }
    // До отметки о начислении: упала добыча — повтор задания дойдёт до неё снова.
    await this.items.dropForRun({
      accountId: row.accountId,
      runId: row.runId,
      survivalSec: job.survivalSec,
      difficultyId: job.difficulty,
      verdict: job.verdict,
      at,
    });
    await this.progress.markCredited(row.runId, credited);
    if (row.levelAfter > row.levelBefore) this.log("log", "level_up", { accountId: row.accountId, from: row.levelBefore, to: row.levelAfter });
    return { ...row, coinsCredited: credited };
  }

  private log(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "progress", event, ...fields }));
  }
}

function jobOf(run: RecordedRun): RewardJob {
  return {
    runId: run.runId,
    accountId: run.accountId,
    difficulty: run.difficulty,
    survivalSec: run.survivalSec,
    enemiesKilled: run.enemiesKilled,
    level: run.level,
    cheats: run.cheats,
    verdict: run.verdict,
    finishedAt: run.finishedAt.toISOString(),
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
