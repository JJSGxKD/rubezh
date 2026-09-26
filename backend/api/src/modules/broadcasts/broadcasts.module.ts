import { Module } from "@nestjs/common";
import { LinksModule } from "../links/links.module.js";
import { MessagingModule } from "../messaging/messaging.module.js";
import { RolesModule } from "../roles/roles.module.js";
import { BroadcastSender } from "./broadcast-sender.js";
import { BroadcastsQueue } from "./broadcasts-queue.js";
import { BROADCASTS_REPOSITORY, PrismaBroadcastsRepository } from "./broadcasts.repository.js";
import { BroadcastsService } from "./broadcasts.service.js";

/**
 * Рассылки в бота (WP17). Своих маршрутов у модуля нет: ими управляет панель
 * (`admin/admin-broadcasts.controller.ts`), а игрок видит только сообщение.
 */
@Module({
  imports: [LinksModule, MessagingModule, RolesModule],
  providers: [{ provide: BROADCASTS_REPOSITORY, useClass: PrismaBroadcastsRepository }, BroadcastSender, BroadcastsQueue, BroadcastsService],
  exports: [BroadcastsService],
})
export class BroadcastsModule {}
