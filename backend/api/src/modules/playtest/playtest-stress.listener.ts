import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { DiagnosticsHooks, type ReceivedReport } from "../diagnostics/diagnostics-hooks.js";
import { PLAYTEST_STATS_STORE, type PlaytestStatsStore } from "./playtest-stats.store.js";

/**
 * Отчёты диагностики в сводке плейтеста (docs/26-stage2-plan.md, WP14). Отчёт
 * принимает модуль диагностики и пишет в Postgres; сводке в Redis нужен
 * только итог: у стресс-теста — пик, причина остановки, устройство; у записи
 * забега — пришла ли и чем проблемна (docs/28-diagnostics.md §6.2).
 */
@Injectable()
export class PlaytestStressListener implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly hooks: DiagnosticsHooks,
    @Inject(PLAYTEST_STATS_STORE) private readonly statsStore: PlaytestStatsStore,
  ) {}

  onModuleInit(): void {
    if (!this.config.playtest.enabled) return;
    this.hooks.onReport("playtest-stats", (report) => this.record(report));
  }

  async record(report: ReceivedReport): Promise<void> {
    if (report.kind === "run") {
      await this.statsStore.recordRecording(report.reportId, report.summary.problems);
      return;
    }
    const { summary } = report;
    await this.statsStore.recordStress(
      {
        reportId: report.reportId,
        build: report.appVersion,
        mode: summary.mode,
        loadout: summary.loadout,
        outcome: summary.outcome,
        device: report.device,
        peakObjects: summary.peakObjects,
        peakEnemies: summary.peakEnemies,
        peakProjectiles: summary.peakProjectiles,
        avgFps: summary.avgFps,
        p95FrameMs: summary.p95FrameMs,
        displayHz: summary.displayHz,
        durationSec: summary.durationSec,
        interruptions: summary.interruptions,
        breakingLoad: summary.breakingLoad,
      },
      report.receivedAt.getTime(),
    );
  }
}
