import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { FriendsController } from "./friends.controller.js";
import { FRIENDS_REPOSITORY, PrismaFriendsRepository } from "./friends.repository.js";
import { FriendsService } from "./friends.service.js";

/**
 * Друзья (docs/35-stage4-plan.md, WP14): граф дружбы, заявки, ссылка дружбы,
 * подарки — монеты кладёт кошелёк.
 * Ссылку исполняет слушатель входа — модуль входа о друзьях не знает.
 */
@Module({
  imports: [AuthModule, WalletModule],
  controllers: [FriendsController],
  providers: [FriendsService, { provide: FRIENDS_REPOSITORY, useClass: PrismaFriendsRepository }],
  exports: [FriendsService, FRIENDS_REPOSITORY],
})
export class FriendsModule {}
