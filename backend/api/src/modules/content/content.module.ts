import { Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { BullContentCheckQueue, CONTENT_CHECK_QUEUE } from "./content-check.queue.js";
import { ContentCheckService } from "./content-check.service.js";
import { CONTENT_REPOSITORY, PrismaContentRepository } from "./content.repository.js";
import { ContentService } from "./content.service.js";

/**
 * Контент игры на сервере (docs/19-content-admin.md §3, docs/35-stage4-plan.md
 * Р16 и Р160, tasks/T-0303): версии, черновики и проверка через sim-worker.
 * Маршруты — в модуле панели (`admin/admin-content.controller.ts`), здесь
 * только сервисы и хранилище. Публикации и версии для клиента — T-0306, T-0307.
 */
@Module({
  providers: [
    ContentService,
    ContentCheckService,
    { provide: CONTENT_REPOSITORY, useClass: PrismaContentRepository },
    { provide: CONTENT_CHECK_QUEUE, inject: [APP_CONFIG], useFactory: (config: AppConfig) => new BullContentCheckQueue(config) },
  ],
  exports: [ContentService, ContentCheckService, CONTENT_REPOSITORY],
})
export class ContentModule {}
