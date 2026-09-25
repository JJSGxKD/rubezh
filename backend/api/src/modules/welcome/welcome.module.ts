import { Module } from "@nestjs/common";
import { BotModule } from "../../platforms/telegram/bot.module.js";
import { renderWelcomePng } from "./welcome-card.js";
import {
  RedisWelcomeCardCache,
  StartCommand,
  WELCOME_CARD_CACHE,
  WELCOME_RENDERER,
  WelcomeProgressRegistry,
} from "./welcome.command.js";

/**
 * Приветствие бота по `/start` (docs/28-diagnostics.md §6.1.2). Рекорд и место
 * подключает модуль с данными через `WelcomeProgressRegistry`.
 */
@Module({
  imports: [BotModule],
  providers: [
    StartCommand,
    WelcomeProgressRegistry,
    { provide: WELCOME_CARD_CACHE, useClass: RedisWelcomeCardCache },
    { provide: WELCOME_RENDERER, useValue: renderWelcomePng },
  ],
  exports: [WelcomeProgressRegistry],
})
export class WelcomeModule {}
