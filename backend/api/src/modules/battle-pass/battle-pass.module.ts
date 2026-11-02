import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { PrismaVipRepository, VIP_REPOSITORY } from "../vip/vip.repository.js";
import { VipModule } from "../vip/vip.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { BattlePassController } from "./battle-pass.controller.js";
import { BATTLE_PASS_REPOSITORY, PrismaBattlePassRepository } from "./battle-pass.repository.js";
import { BattlePassService } from "./battle-pass.service.js";
import { PassCloseJob } from "./pass-close.job.js";
import { PASS_CLOSE_REPOSITORY, PrismaPassCloseRepository } from "./pass-close.repository.js";
import { PassCloseService } from "./pass-close.service.js";

/**
 * Батл-пасс (docs/35-stage4-plan.md Р46, §3.15; tasks/T-0311): месяц по Москве,
 * очки за задания, 30 ступеней в бесплатной и VIP-ленте. Награды — через кошелёк
 * (`pass_reward`) и подарки-бусты. Сервис экспортируется модулю заданий: он
 * прибавляет очки при заборе задания. Закрытие месяца (tasks/T-0312) — задание раз
 * в минуту: незабранное выдаётся само, игроку уходит уведомление.
 *
 * Хранилище VIP подключено ещё раз своим экземпляром: `VipModule` отдаёт наружу
 * только сервис, а закрытию нужен вопрос «был ли VIP в месяце» сразу про пачку
 * игроков. Хранилище без состояния — второй экземпляр ничем не отличается от первого.
 */
@Module({
  imports: [AuthModule, WalletModule, VipModule, NotificationsModule],
  controllers: [BattlePassController],
  providers: [
    BattlePassService,
    PassCloseService,
    PassCloseJob,
    { provide: BATTLE_PASS_REPOSITORY, useClass: PrismaBattlePassRepository },
    { provide: PASS_CLOSE_REPOSITORY, useClass: PrismaPassCloseRepository },
    { provide: VIP_REPOSITORY, useClass: PrismaVipRepository },
  ],
  exports: [BattlePassService],
})
export class BattlePassModule {}
