import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { BotMentionBackoff } from "./bot-mention-backoff.js";
import { BotMentionSweepService } from "./bot-mention-sweep.service.js";
import { BotMentionController } from "./bot-mention.controller.js";
import { BotMentionJob } from "./bot-mention.job.js";
import { BOT_MENTION_REPOSITORY, PrismaBotMentionRepository } from "./bot-mention.repository.js";
import { BotMentionService } from "./bot-mention.service.js";

/**
 * Задания «юзернейм бота» (docs/35-stage4-plan.md Р110, tasks/T-0162): игрок
 * вписывает юзернейм бота в имя и bio на площадке, сервер раз в игровые сутки
 * проверяет через порт `BotMentions` и платит кошельком. Включается и
 * оплачивается ключами группы «Юзернейм бота» в панели: по умолчанию функция
 * выключена, награды равны нулю.
 *
 * Площадка известна только порту (`platforms/ports/bot-mention.ts`); у
 * площадок без бота заданий нет. Экран — отдельная задача (T-0160).
 */
@Module({
  imports: [AuthModule, WalletModule],
  controllers: [BotMentionController],
  providers: [BotMentionService, BotMentionSweepService, BotMentionBackoff, BotMentionJob, { provide: BOT_MENTION_REPOSITORY, useClass: PrismaBotMentionRepository }],
})
export class BotMentionModule {}
