import { Module } from "@nestjs/common";
import { PlaytestAuthGuard } from "./playtest-auth.guard";
import { PlaytestController } from "./playtest.controller";
import { playtestRedisProvider, PlaytestRedisLifecycle } from "./playtest-redis";
import { PlaytestService } from "./playtest.service";
import { PlaytestStatsBot, RedisStatsBotLocks, STATS_BOT_LOCKS, statsBotApiProvider } from "./playtest-stats.bot";
import { PlaytestStatsService } from "./playtest-stats.service";
import { PLAYTEST_STATS_STORE } from "./playtest-stats.store";
import { PLAYTEST_STORE } from "./playtest.store";
import { RedisPlaytestStatsStore } from "./redis-playtest-stats.store";
import { RedisPlaytestStore } from "./redis-playtest.store";

@Module({
  controllers: [PlaytestController],
  providers: [
    playtestRedisProvider,
    PlaytestRedisLifecycle,
    PlaytestService,
    PlaytestAuthGuard,
    { provide: PLAYTEST_STORE, useClass: RedisPlaytestStore },
    { provide: PLAYTEST_STATS_STORE, useClass: RedisPlaytestStatsStore },
    PlaytestStatsService,
    // Бот стартует, только если сводка включена (PLAYTEST_STATS_ENABLED):
    // провайдер есть всегда, цикл чтения — нет.
    PlaytestStatsBot,
    statsBotApiProvider,
    { provide: STATS_BOT_LOCKS, useClass: RedisStatsBotLocks },
  ],
})
export class PlaytestModule {}
