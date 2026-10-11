import { Module } from "@nestjs/common";
import { AdAudience } from "../../modules/ads/ad-audience.js";
import { AdsModule } from "../../modules/ads/ads.module.js";
import { AuthModule } from "../../modules/auth/auth.module.js";
import { RunsModule } from "../../modules/runs/runs.module.js";
import { BotFallbackReply } from "./bot-fallback.js";
import { BotModule } from "./bot.module.js";
import { renderWelcomePng } from "./welcome-card.js";
import { RunsWelcomeProgress } from "./welcome-progress.js";
import {
  BOT_START_LISTENER,
  RedisWelcomeCardCache,
  StartCommand,
  WELCOME_CARD_CACHE,
  WELCOME_RENDERER,
  WelcomeProgressRegistry,
} from "./welcome.command.js";

/**
 * Приветствие бота по `/start` (docs/28-diagnostics.md §6.1.2): рекорд и место
 * игрока — из забегов под аккаунтом (`welcome-progress.ts`). Запуск бота
 * слушает модуль рекламы: сеть так учитывает аудиторию бота (Р78).
 */
@Module({
  imports: [BotModule, AuthModule, RunsModule, AdsModule],
  providers: [
    StartCommand,
    BotFallbackReply,
    WelcomeProgressRegistry,
    RunsWelcomeProgress,
    { provide: WELCOME_CARD_CACHE, useClass: RedisWelcomeCardCache },
    { provide: WELCOME_RENDERER, useValue: renderWelcomePng },
    { provide: BOT_START_LISTENER, useExisting: AdAudience },
  ],
  exports: [WelcomeProgressRegistry],
})
export class WelcomeModule {}
