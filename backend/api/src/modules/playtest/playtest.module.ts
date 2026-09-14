import { Module } from "@nestjs/common";
import { PlaytestAuthGuard } from "./playtest-auth.guard";
import { PlaytestController } from "./playtest.controller";
import { PlaytestService } from "./playtest.service";
import { PLAYTEST_STORE } from "./playtest.store";
import { RedisPlaytestStore } from "./redis-playtest.store";

@Module({
  controllers: [PlaytestController],
  providers: [
    PlaytestService,
    PlaytestAuthGuard,
    { provide: PLAYTEST_STORE, useClass: RedisPlaytestStore },
  ],
})
export class PlaytestModule {}
