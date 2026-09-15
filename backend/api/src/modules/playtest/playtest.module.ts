import { Module } from "@nestjs/common";
import { BotModule } from "../bot/bot.module.js";
import { DiagnosticsModule } from "../diagnostics/diagnostics.module.js";
import { PlaytestAuthGuard } from "./playtest-auth.guard.js";
import { PlaytestController } from "./playtest.controller.js";
import { PlaytestService } from "./playtest.service.js";
import { PlaytestStatsReporter, RedisStatsReporterLocks, STATS_REPORTER_LOCKS } from "./playtest-stats.reporter.js";
import { PlaytestStatsService } from "./playtest-stats.service.js";
import { PlaytestStressListener } from "./playtest-stress.listener.js";
import { PLAYTEST_STATS_STORE } from "./playtest-stats.store.js";
import { PLAYTEST_STORE } from "./playtest.store.js";
import { RedisPlaytestStatsStore } from "./redis-playtest-stats.store.js";
import { RedisPlaytestStore } from "./redis-playtest.store.js";

@Module({
  imports: [BotModule, DiagnosticsModule],
  controllers: [PlaytestController],
  providers: [
    PlaytestService,
    PlaytestAuthGuard,
    { provide: PLAYTEST_STORE, useClass: RedisPlaytestStore },
    { provide: PLAYTEST_STATS_STORE, useClass: RedisPlaytestStatsStore },
    PlaytestStatsService,
    PlaytestStressListener,
    // Сводка отвечает на /stats и шлёт отчёт раз в сутки, только если
    // включена (PLAYTEST_STATS_ENABLED): провайдер есть всегда, работы — нет.
    PlaytestStatsReporter,
    { provide: STATS_REPORTER_LOCKS, useClass: RedisStatsReporterLocks },
  ],
})
export class PlaytestModule {}
