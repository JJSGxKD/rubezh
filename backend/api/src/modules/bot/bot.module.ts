import { Module } from "@nestjs/common";
import { BOT_POLLER_LOCKS, BotPoller, RedisBotPollerLocks } from "./bot-poller.js";
import { BotCommands } from "./bot-commands.js";
import { BotRouter } from "./bot-router.js";
import { BotUpdateDedupe, BotWebhookController } from "./bot-webhook.controller.js";

/**
 * Бот закрытого теста (docs/28-diagnostics.md §6.1): откуда приходят
 * обновления — вебхук или long polling — и куда их передать. Команды
 * регистрируют модули-владельцы через `BotRouter`, а меню Telegram и `/help`
 * собираются из них в `BotCommands`.
 *
 * Транспорт — grammY за нашим `TelegramBotApi`, а маршрутизация, лок опроса
 * и вебхук — свои: у grammY нет лока на несколько процессов
 * (docs/16-tech-stack-decisions.md §5).
 */
@Module({
  controllers: [BotWebhookController],
  providers: [BotRouter, BotCommands, BotPoller, BotUpdateDedupe, { provide: BOT_POLLER_LOCKS, useClass: RedisBotPollerLocks }],
  exports: [BotRouter],
})
export class BotModule {}
