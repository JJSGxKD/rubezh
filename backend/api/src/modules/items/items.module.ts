import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { ItemsController } from "./items.controller.js";
import { ItemsLoadoutCheck } from "./items-loadout-check.js";
import { ITEMS_REPOSITORY, PrismaItemsRepository } from "./items.repository.js";
import { ITEM_SEEDS, ItemsService, cryptoSeeds } from "./items.service.js";

/**
 * Снаряжение (docs/35-stage4-plan.md §3.4, WP7): инвентарь, операции над
 * предметами и подписанный снимок надетого. Добычу выдаёт задание наград
 * за забег — отсюда экспорт сервиса; проверку снимка в итоге забега модуль
 * подключает к забегам сам (`items-loadout-check.ts`).
 */
@Module({
  imports: [AuthModule, WalletModule, RunsModule],
  controllers: [ItemsController],
  providers: [ItemsService, ItemsLoadoutCheck, { provide: ITEMS_REPOSITORY, useClass: PrismaItemsRepository }, { provide: ITEM_SEEDS, useValue: cryptoSeeds }],
  exports: [ItemsService],
})
export class ItemsModule {}
