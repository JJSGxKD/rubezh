import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { ProgressModule } from "../progress/progress.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { WheelController } from "./wheel.controller.js";
import { PrismaWheelRepository, WHEEL_REPOSITORY } from "./wheel.repository.js";
import { WHEEL_ROLL, WheelService, cryptoRoll } from "./wheel.service.js";

/**
 * Колесо (docs/35-stage4-plan.md Р45, WP13): бесплатная крутка раз в
 * московские сутки, сектора от уровня, результат выбирает сервер. Награду
 * кладёт кошелёк ключом крутки.
 */
@Module({
  imports: [AuthModule, ProgressModule, WalletModule],
  controllers: [WheelController],
  providers: [WheelService, { provide: WHEEL_REPOSITORY, useClass: PrismaWheelRepository }, { provide: WHEEL_ROLL, useValue: cryptoRoll }],
  exports: [WheelService],
})
export class WheelModule {}
