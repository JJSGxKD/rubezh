import { Module, type OnModuleInit } from "@nestjs/common";
import { Outbound } from "../../infra/outbound/outbound.js";
import { ExternalIdentityModule } from "../../modules/external-identity/external-identity.module.js";
import { SECRETS_READER, type SecretsReader } from "../../modules/secrets/secrets.service.js";
import { SETTINGS_READER, type SettingsReader } from "../../modules/settings/settings.service.js";
import { ChannelMemberships } from "../ports/channel-membership.js";
import { ExternalLinkStarters } from "../ports/external-link.js";
import { VkApi } from "./vk-api.js";
import { VkCallbackController } from "./vk-callback.controller.js";
import { VkChannelMembership } from "./vk-channel-membership.js";
import { VkCommunity } from "./vk-community.js";
import { VkEventQueue } from "./vk-event-queue.js";
import { VkLinkStarter } from "./vk-link-starter.js";
import { VkUpdatesWorker } from "./vk-updates.worker.js";

/**
 * Сообщество VK как бот для заданий (docs/35-stage4-plan.md Р188,
 * tasks/T-0378): вебхук Callback API, очередь событий и воркер, который
 * связывает аккаунт игрока по коду из ссылки. Игру во VK модуль не портирует.
 *
 * Домен про VK не знает: адаптер подключает себя к портам сам, при старте
 * модуля, — проверка вступления в `ChannelMemberships`, ссылка на бота в
 * `ExternalLinkStarters`. Модули домена видят только порты.
 *
 * Включается ключом: пока в «Ключах интеграций» нет ключа сообщества или в
 * «Настройках» не названо сообщество, вебхук отвечает 404, ссылки на бота нет, а
 * задания-сообщества VK игрокам других площадок не видны.
 */
@Module({
  imports: [ExternalIdentityModule],
  controllers: [VkCallbackController],
  providers: [
    { provide: VkCommunity, inject: [SECRETS_READER, SETTINGS_READER], useFactory: (secrets: SecretsReader, settings: SettingsReader): VkCommunity => new VkCommunity(secrets, settings) },
    // Через клиент исходящих: у него журнал запросов и прокси.
    { provide: VkApi, inject: [VkCommunity, Outbound], useFactory: (community: VkCommunity, outbound: Outbound): VkApi => new VkApi(community, outbound.forService("vk.api")) },
    VkUpdatesWorker,
    VkEventQueue,
  ],
})
export class VkModule implements OnModuleInit {
  constructor(
    private readonly api: VkApi,
    private readonly community: VkCommunity,
    private readonly memberships: ChannelMemberships,
    private readonly starters: ExternalLinkStarters,
  ) {}

  onModuleInit(): void {
    this.memberships.register(new VkChannelMembership(this.api));
    this.starters.register(new VkLinkStarter(this.community));
  }
}
