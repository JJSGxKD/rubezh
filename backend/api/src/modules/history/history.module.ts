import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { HistoryController } from "./history.controller.js";
import { HISTORY_REPOSITORY, PrismaHistoryRepository } from "./history.repository.js";
import { HistoryService } from "./history.service.js";

/**
 * История имущества (docs/35-stage4-plan.md Р51): модель чтения поверх
 * журналов кошелька, предметов и покупок. Своих таблиц нет — поэтому
 * история не может разойтись с балансом.
 */
@Module({
  imports: [AuthModule],
  controllers: [HistoryController],
  providers: [HistoryService, { provide: HISTORY_REPOSITORY, useClass: PrismaHistoryRepository }],
})
export class HistoryModule {}
