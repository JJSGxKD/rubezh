import { Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { AuthModule } from "../auth/auth.module.js";
import { BullContentCheckQueue, CONTENT_CHECK_QUEUE } from "./content-check.queue.js";
import { ContentCheckService } from "./content-check.service.js";
import { ContentDeliveryController } from "./content-delivery.controller.js";
import { ContentDeliveryService } from "./content-delivery.service.js";
import { CONTENT_PUBLISH_LOCK, RedisContentPublishLock } from "./content-publish-lock.js";
import { CONTENT_PUBLISH_REPOSITORY, PrismaContentPublishRepository } from "./content-publish.repository.js";
import { ContentPublishService } from "./content-publish.service.js";
import { CONTENT_REPOSITORY, PrismaContentRepository } from "./content.repository.js";
import { ContentService } from "./content.service.js";

/**
 * Контент игры на сервере (docs/19-content-admin.md §3, docs/35-stage4-plan.md
 * Р16 и Р160, tasks/T-0303, T-0306): версии, черновики, проверка через
 * sim-worker, публикация с откатом и выдача версии клиенту. Маршруты панели —
 * в модуле панели (`admin/admin-content.controller.ts`), здесь сервисы,
 * хранилище и маршруты клиента (`/content`). Загрузку версии клиентом делает
 * T-0307.
 */
@Module({
  imports: [AuthModule],
  controllers: [ContentDeliveryController],
  providers: [
    ContentService,
    ContentCheckService,
    ContentPublishService,
    ContentDeliveryService,
    { provide: CONTENT_REPOSITORY, useClass: PrismaContentRepository },
    { provide: CONTENT_PUBLISH_REPOSITORY, useClass: PrismaContentPublishRepository },
    { provide: CONTENT_PUBLISH_LOCK, useClass: RedisContentPublishLock },
    { provide: CONTENT_CHECK_QUEUE, inject: [APP_CONFIG], useFactory: (config: AppConfig) => new BullContentCheckQueue(config) },
  ],
  exports: [ContentService, ContentCheckService, ContentPublishService, CONTENT_REPOSITORY, CONTENT_PUBLISH_REPOSITORY],
})
export class ContentModule {}
