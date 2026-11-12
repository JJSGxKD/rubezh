import { Module } from "@nestjs/common";
import { ExternalIdentityModule } from "../../modules/external-identity/external-identity.module.js";
import { VkCallbackController } from "./vk-callback.controller.js";
import { VkEventQueue } from "./vk-event-queue.js";
import { VkUpdatesWorker } from "./vk-updates.worker.js";

/**
 * Сообщество VK как бот для заданий (docs/35-stage4-plan.md Р188,
 * tasks/T-0378): вебхук Callback API, очередь событий и воркер, который
 * связывает аккаунт игрока по коду из ссылки. Игру во VK модуль не портирует.
 *
 * Ключи, настройка сообщества, клиент методов, проверка вступления и ссылка на
 * бота — провайдеры глобального `PlatformsModule`: он единственный собирает
 * порты площадок (`ChannelMemberships`, `ExternalLinkStarters`), и модули
 * домена видят только порты.
 */
@Module({
  imports: [ExternalIdentityModule],
  controllers: [VkCallbackController],
  providers: [VkUpdatesWorker, VkEventQueue],
})
export class VkModule {}
