import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { MessagingModule } from "../messaging/messaging.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { FriendNotifier } from "./friend-notifier.js";
import { FriendsController } from "./friends.controller.js";
import { FRIENDS_REPOSITORY, PrismaFriendsRepository } from "./friends.repository.js";
import { FriendsService } from "./friends.service.js";

/**
 * Друзья (docs/35-stage4-plan.md, WP14): граф дружбы, заявки, ссылка дружбы,
 * подарки — монеты кладёт кошелёк, сообщение о заявке — бот площадки.
 * Ссылку исполняет слушатель входа — модуль входа о друзьях не знает.
 */
@Module({
  imports: [AuthModule, WalletModule, MessagingModule],
  controllers: [FriendsController],
  providers: [FriendsService, FriendNotifier, { provide: FRIENDS_REPOSITORY, useClass: PrismaFriendsRepository }],
  exports: [FriendsService, FRIENDS_REPOSITORY],
})
export class FriendsModule {}
