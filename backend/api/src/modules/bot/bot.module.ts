import { Module } from "@nestjs/common";
import { BOT_POLLER_LOCKS, BotPoller, RedisBotPollerLocks } from "./bot-poller.js";
import { BotRouter } from "./bot-router.js";
import { BotUpdateDedupe, BotWebhookController } from "./bot-webhook.controller.js";

/**
 * Бот закрытого теста (docs/28-diagnostics.md §6.1): откуда приходят
 * обновления — вебхук или long polling — и куда их передать. Команды
 * регистрируют модули-владельцы через `BotRouter`.
 *
 * Библиотеки бота нет: нужен десяток методов Bot API, и тонкий клиент на
 * `fetch` с разбором ответов схемой проще фреймворка вокруг них
 * (docs/16-tech-stack-decisions.md §5).
 */
@Module({
  controllers: [BotWebhookController],
  providers: [BotRouter, BotPoller, BotUpdateDedupe, { provide: BOT_POLLER_LOCKS, useClass: RedisBotPollerLocks }],
  exports: [BotRouter],
})
export class BotModule {}
