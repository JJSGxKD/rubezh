import { Global, Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { BotIdentity } from "./bot-identity.js";
import { TelegramBotApi } from "./telegram-bot-api.js";

/**
 * Telegram для всего бэкенда: клиент Bot API на токене бота закрытого теста.
 * Проверка подписи `initData` — чистая функция (`telegram-init-data.ts`) и в
 * DI не нуждается.
 */
export const TELEGRAM_BOT_API = Symbol("TELEGRAM_BOT_API");

@Global()
@Module({
  providers: [
    {
      provide: TELEGRAM_BOT_API,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): TelegramBotApi => new TelegramBotApi(config.telegram.botToken),
    },
    BotIdentity,
  ],
  exports: [TELEGRAM_BOT_API, BotIdentity],
})
export class TelegramModule {}
