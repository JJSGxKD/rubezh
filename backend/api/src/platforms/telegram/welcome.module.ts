import { Module } from "@nestjs/common";
import { AuthModule } from "../../modules/auth/auth.module.js";
import { RunsModule } from "../../modules/runs/runs.module.js";
import { BotModule } from "./bot.module.js";
import { renderWelcomePng } from "./welcome-card.js";
import { RunsWelcomeProgress } from "./welcome-progress.js";
import {
  RedisWelcomeCardCache,
  StartCommand,
  WELCOME_CARD_CACHE,
  WELCOME_RENDERER,
  WelcomeProgressRegistry,
} from "./welcome.command.js";

/**
 * Приветствие бота по `/start` (docs/28-diagnostics.md §6.1.2): рекорд и место
 * игрока — из забегов под аккаунтом (`welcome-progress.ts`).
 */
@Module({
  imports: [BotModule, AuthModule, RunsModule],
  providers: [
    StartCommand,
    WelcomeProgressRegistry,
    RunsWelcomeProgress,
    { provide: WELCOME_CARD_CACHE, useClass: RedisWelcomeCardCache },
    { provide: WELCOME_RENDERER, useValue: renderWelcomePng },
  ],
  exports: [WelcomeProgressRegistry],
})
export class WelcomeModule {}
