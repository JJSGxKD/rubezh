import { Global, Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { Outbound } from "../../infra/outbound/outbound.js";
import { BotIdentity } from "./bot-identity.js";
import { TELEGRAM_BOT_API, TelegramBotApi } from "./telegram-bot-api.js";

/**
 * Telegram для всего бэкенда: клиент Bot API на токене бота закрытого теста.
 * Проверка подписи `initData` — чистая функция (`telegram-init-data.ts`) и в
 * DI не нуждается.
 */
@Global()
@Module({
  providers: [
    {
      provide: TELEGRAM_BOT_API,
      inject: [APP_CONFIG, Outbound],
      useFactory: (config: AppConfig, outbound: Outbound): TelegramBotApi =>
        new TelegramBotApi(config.telegram.botToken, config.telegram.apiRoot, outbound.forService("telegram.bot")),
    },
    BotIdentity,
  ],
  exports: [TELEGRAM_BOT_API, BotIdentity],
})
export class TelegramModule {}
