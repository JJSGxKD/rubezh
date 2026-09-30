import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { WalletBonuses } from "./wallet-bonus.js";
import { WalletController } from "./wallet.controller.js";
import { PrismaWalletRepository, WALLET_REPOSITORY } from "./wallet.repository.js";
import { WalletService } from "./wallet.service.js";

/**
 * Кошелёк: журнал, балансы, суточные потолки (docs/35-stage4-plan.md, WP3).
 * Начисляют из него награды за забег, задания, покупки и друзья — отсюда
 * экспорт сервиса; сам по себе игроку кошелёк только показывается.
 */
@Module({
  imports: [AuthModule],
  controllers: [WalletController],
  providers: [WalletService, WalletBonuses, { provide: WALLET_REPOSITORY, useClass: PrismaWalletRepository }],
  // Надбавки — VIP: он регистрирует свою, кошелёк о нём не знает.
  exports: [WalletService, WalletBonuses],
})
export class WalletModule {}
