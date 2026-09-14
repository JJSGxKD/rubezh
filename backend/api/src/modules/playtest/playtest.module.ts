import { Module } from "@nestjs/common";
import { PlaytestAuthGuard } from "./playtest-auth.guard";
import { PlaytestController } from "./playtest.controller";
import { playtestRedisProvider, PlaytestRedisLifecycle } from "./playtest-redis";
import { PlaytestService } from "./playtest.service";
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
  ],
})
export class PlaytestModule {}
