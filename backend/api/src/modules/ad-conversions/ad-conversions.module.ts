import { Module } from "@nestjs/common";
import { ConversionsJournal } from "./conversions-journal.service.js";
import { CONVERSIONS_REPOSITORY, PrismaConversionsRepository } from "./conversions.repository.js";
import { AdConversionsService } from "./conversions.service.js";

/**
 * Конверсии закупленной рекламы (WP43, docs/35-stage4-plan.md Р86): вывод
 * из фактов, отправка постбэком в кабинет сети, журнал для панели.
 */
@Module({
  providers: [AdConversionsService, ConversionsJournal, { provide: CONVERSIONS_REPOSITORY, useClass: PrismaConversionsRepository }],
  exports: [ConversionsJournal],
})
export class AdConversionsModule {}
