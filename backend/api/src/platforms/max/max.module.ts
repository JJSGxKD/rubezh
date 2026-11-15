import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { Outbound } from "../../infra/outbound/outbound.js";
import { ExternalIdentityModule } from "../../modules/external-identity/external-identity.module.js";
import { ExternalIdentityService } from "../../modules/external-identity/external-identity.service.js";
import { SECRETS } from "../../modules/secrets/secret-catalog.js";
import { SECRETS_READER, type SecretsReader } from "../../modules/secrets/secrets.service.js";
import { SETTINGS_READER, type SettingsReader } from "../../modules/settings/settings.service.js";
import { TasksModule } from "../../modules/tasks/tasks.module.js";
import { TASKS_REPOSITORY, type TasksRepository } from "../../modules/tasks/tasks.repository.js";
import { ChannelMemberships } from "../ports/channel-membership.js";
import { ExternalLinkStarters } from "../ports/external-link.js";
import { MaxBotApi } from "./max-bot-api.js";
import { MaxChannelLinks } from "./max-channel-links.js";
import { MaxChannelMembership } from "./max-channel-membership.js";
import { MaxLinkStarter } from "./max-link-starter.js";
import { MaxSubscriptionService } from "./max-subscription.service.js";
import { MaxUpdateQueue } from "./max-update-queue.js";
import { MaxUpdatesWorker } from "./max-updates.worker.js";
import { MaxWebhookController } from "./max-webhook.controller.js";

/**
 * Бот MAX для заданий-каналов (docs/35-stage4-plan.md Р188, tasks/T-0379): игрок
 * открывает бота по ссылке из задания, бот связывает его аккаунт MAX с игровым и
 * присылает ссылку на канал, а сервер проверяет подписку через Bot API MAX. Игру
 * бот не портирует — это этап 7 (`02-roadmap.md`).
 *
 * Домен про MAX не знает: адаптер подключает себя к портам сам, при старте
 * модуля, — проверка подписки в `ChannelMemberships`, ссылка на бота в
 * `ExternalLinkStarters`. Модули домена видят только порты.
 *
 * Включается ключом: пока в «Ключах интеграций» нет ключа бота, вебхук отвечает
 * 404, ссылки на бота нет, а задания-каналы MAX игрокам других площадок не видны.
 */
@Module({
  imports: [ExternalIdentityModule, TasksModule],
  controllers: [MaxWebhookController],
  providers: [
    {
      provide: MaxBotApi,
      inject: [Outbound, SECRETS_READER],
      useFactory: (outbound: Outbound, secrets: SecretsReader): MaxBotApi => new MaxBotApi(() => secrets.get(SECRETS.maxBotToken), outbound.forService("max.bot")),
    },
    { provide: MaxChannelLinks, inject: [TASKS_REPOSITORY], useFactory: (tasks: TasksRepository): MaxChannelLinks => new MaxChannelLinks(tasks) },
    {
      provide: MaxUpdatesWorker,
      inject: [ExternalIdentityService, MaxBotApi, MaxChannelLinks],
      useFactory: (identity: ExternalIdentityService, api: MaxBotApi, channels: MaxChannelLinks): MaxUpdatesWorker => new MaxUpdatesWorker(identity, api, channels),
    },
    MaxUpdateQueue,
    {
      provide: MaxSubscriptionService,
      inject: [MaxBotApi, SECRETS_READER, APP_CONFIG],
      useFactory: (api: MaxBotApi, secrets: SecretsReader, config: AppConfig): MaxSubscriptionService => new MaxSubscriptionService(api, secrets, config),
    },
  ],
})
export class MaxModule implements OnModuleInit {
  constructor(
    private readonly api: MaxBotApi,
    @Inject(SECRETS_READER) private readonly secrets: SecretsReader,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    private readonly memberships: ChannelMemberships,
    private readonly starters: ExternalLinkStarters,
  ) {}

  onModuleInit(): void {
    this.memberships.register(new MaxChannelMembership(this.api));
    this.starters.register(new MaxLinkStarter(this.secrets, this.settings));
  }
}
