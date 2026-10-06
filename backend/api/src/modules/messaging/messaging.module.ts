import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { MESSAGING_REPOSITORY, PrismaMessagingRepository } from "./messaging.repository.js";
import { MessagingService } from "./messaging.service.js";

/**
 * Можно ли писать игроку (docs/35-stage4-plan.md, WP2). Рассылки и
 * уведомления читают это состояние отсюда; меняют его вход в канал и адаптеры
 * площадок.
 */
@Module({
  imports: [AuthModule],
  providers: [MessagingService, { provide: MESSAGING_REPOSITORY, useClass: PrismaMessagingRepository }],
  exports: [MessagingService],
})
export class MessagingModule {}
