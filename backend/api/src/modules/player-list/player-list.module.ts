import { Module } from "@nestjs/common";
import { PLAYER_LIST_REPOSITORY, PrismaPlayerListRepository } from "./player-list.repository.js";
import { PlayerListService } from "./player-list.service.js";

/**
 * Список игроков для панели (docs/35-stage4-plan.md WP32): модель чтения
 * поверх таблиц аккаунта, уровня, привлечения, воронки и «можно писать».
 * Маршрутов своих нет — список отдаёт панель (`admin/admin-players.controller.ts`).
 */
@Module({
  providers: [PlayerListService, { provide: PLAYER_LIST_REPOSITORY, useClass: PrismaPlayerListRepository }],
  exports: [PlayerListService],
})
export class PlayerListModule {}
