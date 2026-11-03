import { Module } from "@nestjs/common";
import { EventsModule } from "../events/events.module.js";
import { BundledExpectedTable, EXPECTED_TABLE_SOURCE } from "./expected-table.js";
import { PrismaRunScoresRepository, RUN_SCORES_REPOSITORY } from "./run-scores.repository.js";
import { RunScorer } from "./run-scorer.service.js";

/**
 * Очки эффективности забега (tasks/T-0293, Р66, Р152): таблица ожидаемого из
 * файла, подсчёт пяти осей по ключам панели и пересчёт прошлых забегов. Забеги
 * зовут `RunScorer` при записи итога; доски по очкам — T-0294.
 */
@Module({
  imports: [EventsModule],
  providers: [RunScorer, { provide: EXPECTED_TABLE_SOURCE, useClass: BundledExpectedTable }, { provide: RUN_SCORES_REPOSITORY, useClass: PrismaRunScoresRepository }],
  exports: [RunScorer, RUN_SCORES_REPOSITORY, EXPECTED_TABLE_SOURCE],
})
export class RatingModule {}
