import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { RestrictionsModule } from "../restrictions/restrictions.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { SeasonsModule } from "../seasons/seasons.module.js";
import { FeedController } from "./feed.controller.js";
import { FEED_REPOSITORY, LiveFeedRepository } from "./feed.repository.js";
import { FeedService } from "./feed.service.js";

/**
 * Лента живых событий на главной (Р114, docs/35-stage4-plan.md; tasks/T-0174):
 * настоящие события за сутки — длинный забег и рекорд недели. Модуль забегов о
 * ленте не знает: слушатель подписывается сам, как у сезонов.
 */
@Module({
  imports: [AuthModule, RunsModule, SeasonsModule, RestrictionsModule],
  controllers: [FeedController],
  providers: [FeedService, RateLimiter, { provide: FEED_REPOSITORY, useClass: LiveFeedRepository }],
})
export class FeedModule {}
