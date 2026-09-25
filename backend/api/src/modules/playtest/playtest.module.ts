import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { BotModule } from "../../platforms/telegram/bot.module.js";
import { DiagnosticsModule } from "../diagnostics/diagnostics.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { WelcomeModule } from "../welcome/welcome.module.js";
import { PlaytestController } from "./playtest.controller.js";
import { PlaytestService } from "./playtest.service.js";
import { PlaytestRunsListener } from "./playtest-runs.listener.js";
import { PlaytestStatsReporter, RedisStatsReporterLocks, STATS_REPORTER_LOCKS } from "./playtest-stats.reporter.js";
import { PlaytestStatsService } from "./playtest-stats.service.js";
import { PlaytestStressListener } from "./playtest-stress.listener.js";
import { PlaytestWelcomeProgress } from "./playtest-welcome.progress.js";
import { PLAYTEST_STATS_STORE } from "./playtest-stats.store.js";
import { RedisPlaytestStatsStore } from "./redis-playtest-stats.store.js";

/**
 * Сводка плейтеста и то, что к забегам не относится: отчёты о запуске и
 * доступ к инструментам. Забеги и рейтинг — в модуле `runs`
 * (docs/34-stage3-plan.md, WP4): сводка читает их хуки и рейтинг.
 */
@Module({
  imports: [AuthModule, BotModule, DiagnosticsModule, RunsModule, WelcomeModule],
  controllers: [PlaytestController],
  providers: [
    PlaytestService,
    { provide: PLAYTEST_STATS_STORE, useClass: RedisPlaytestStatsStore },
    PlaytestStatsService,
    PlaytestRunsListener,
    PlaytestStressListener,
    PlaytestWelcomeProgress,
    // Сводка отвечает на /stats и шлёт отчёт раз в сутки, только если
    // включена (PLAYTEST_STATS_ENABLED): провайдер есть всегда, работы — нет.
    PlaytestStatsReporter,
    { provide: STATS_REPORTER_LOCKS, useClass: RedisStatsReporterLocks },
  ],
})
export class PlaytestModule {}
