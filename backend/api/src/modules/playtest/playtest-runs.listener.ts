import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { RunsHooks, type RecordedRun } from "../runs/runs-hooks.js";
import { PLAYTEST_STATS_STORE, type PlaytestStatsStore } from "./playtest-stats.store.js";

/**
 * Забеги в сводке плейтеста (docs/26-stage2-plan.md, WP14). Забег принимает и
 * хранит модуль `runs` (docs/34-stage3-plan.md, WP4); сводке нужны только
 * счётчики, и она получает их из его хуков — по первой записи, не по повтору.
 */
@Injectable()
export class PlaytestRunsListener implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly hooks: RunsHooks,
    @Inject(PLAYTEST_STATS_STORE) private readonly statsStore: PlaytestStatsStore,
  ) {}

  onModuleInit(): void {
    if (!this.config.playtest.enabled) return;
    this.hooks.onRecorded("playtest-stats", (run) => this.record(run));
  }

  /**
   * Забег с читами — проверка разработчика, а не игра, как и отклонённый
   * антифродом: забег дольше, чем прошло времени, исказил бы длительности.
   * Подозрительный остаётся — по порогам, снятым на глаз, он чаще честный.
   */
  async record(run: RecordedRun): Promise<void> {
    if (run.cheats || run.verdict === "rejected") return;
    await this.statsStore.recordRun(
      run.accountId,
      {
        difficultyId: run.difficulty,
        outcome: run.outcome,
        survivalSec: run.survivalSec,
        level: run.level,
        startingWeaponId: run.startingWeaponId,
        deathCause: run.deathCause,
      },
      run.finishedAt.getTime(),
    );
  }
}
