import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { EventsModule } from "../events/events.module.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { BundledExpectedTable, EXPECTED_TABLE_SOURCE } from "./expected-table.js";
import { PLAYER_STYLE_REPOSITORY, PlayerStyleService, PrismaPlayerStyleRepository } from "./player-style.service.js";
import { RatingController } from "./rating.controller.js";
import { PrismaRunScoresRepository, RUN_SCORES_REPOSITORY } from "./run-scores.repository.js";
import { RunScorer } from "./run-scorer.service.js";

/**
 * Очки эффективности забега (tasks/T-0293, Р66, Р152): таблица ожидаемого из
 * файла, подсчёт пяти осей по ключам панели и пересчёт прошлых забегов. Забеги
 * зовут `RunScorer` при записи итога; доски по очкам — T-0294; стиль игрока и
 * `GET /rating/me/style` — T-0295 (дивизионы считает сезон по правилам
 * `division-rules.ts`).
 */
@Module({
  imports: [AuthModule, EventsModule],
  controllers: [RatingController],
  providers: [
    RunScorer,
    PlayerStyleService,
    RateLimiter,
    { provide: EXPECTED_TABLE_SOURCE, useClass: BundledExpectedTable },
    { provide: RUN_SCORES_REPOSITORY, useClass: PrismaRunScoresRepository },
    { provide: PLAYER_STYLE_REPOSITORY, useClass: PrismaPlayerStyleRepository },
  ],
  exports: [RunScorer, PlayerStyleService, RUN_SCORES_REPOSITORY, EXPECTED_TABLE_SOURCE],
})
export class RatingModule {}
