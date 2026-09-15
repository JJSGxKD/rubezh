import { Module } from "@nestjs/common";
import { PlaytestAuthGuard } from "./playtest-auth.guard.js";
import { PlaytestController } from "./playtest.controller.js";
import { playtestRedisProvider, PlaytestRedisLifecycle } from "./playtest-redis.js";
import { PlaytestService } from "./playtest.service.js";
import { PlaytestStatsBot, RedisStatsBotLocks, STATS_BOT_LOCKS, statsBotApiProvider } from "./playtest-stats.bot.js";
import { PlaytestStatsService } from "./playtest-stats.service.js";
import { PLAYTEST_STATS_STORE } from "./playtest-stats.store.js";
import { PLAYTEST_STORE } from "./playtest.store.js";
import { RedisPlaytestStatsStore } from "./redis-playtest-stats.store.js";
import { RedisPlaytestStore } from "./redis-playtest.store.js";

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
