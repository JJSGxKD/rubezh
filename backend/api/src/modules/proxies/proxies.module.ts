import { Global, Module } from "@nestjs/common";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { Outbound } from "../../infra/outbound/outbound.js";
import { OUTBOUND_PROXY_FETCH, OUTBOUND_ROUTES, type ProxyFetch } from "../../infra/outbound/outbound-route.js";
import { REDIS } from "../../infra/redis.js";
import { SecretCipher } from "../secrets/secret-cipher.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { ProxiesService } from "./proxies.service.js";
import { PROXIES_REPOSITORY, PrismaProxiesRepository } from "./proxies.repository.js";
import { PROXY_CIPHER } from "./proxy-password.js";
import { ProxyRoutes } from "./proxy-routes.service.js";
import { HOST_RESOLVER, systemResolver, type HostResolver } from "./subscription/subscription-download.js";
import { SubscriptionRoutes } from "./subscription/subscription-routes.js";
import { SUBSCRIPTION_REPOSITORY, PrismaSubscriptionRepository, type SubscriptionRepository } from "./subscription/subscription.repository.js";
import { SubscriptionScheduler } from "./subscription/subscription.scheduler.js";
import { ProxySubscriptionService } from "./subscription/subscription.service.js";
import { SubscriptionSync } from "./subscription/subscription.sync.js";
import { CONFIG_WRITER, FileConfigWriter, type ConfigWriter } from "./subscription/xray-config-writer.js";

/**
 * Прокси для исходящих запросов (docs/35-stage4-plan.md Р91, tasks/T-0065) и
 * подписка Xray (Р101, tasks/T-0093).
 *
 * Модуль глобальный, как приёмник журнала запросов: клиент исходящих
 * (`infra/outbound`) берёт список прокси и режимы из `OUTBOUND_ROUTES`, не
 * зная о доменном модуле, а без базы остаётся прямой путь. Права, проверка
 * формы и аудит — в `ProxiesService` и контроллере панели. Узлы подписки идут
 * в тот же список после ручных прокси.
 *
 * Шифр пароля тот же, что у ключей интеграций (`SECRETS_ENCRYPTION_KEY`); без
 * ключа или без базы пароль прокси и адрес подписки сохранить нельзя, прокси
 * без пароля работают.
 */
@Global()
@Module({
  providers: [
    { provide: PROXIES_REPOSITORY, useClass: PrismaProxiesRepository },
    {
      provide: PROXY_CIPHER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): SecretCipher | null => (config.secrets.encryptionKeys.length === 0 || config.databaseUrl === "" ? null : new SecretCipher(config.secrets.encryptionKeys)),
    },
    { provide: SUBSCRIPTION_REPOSITORY, useClass: PrismaSubscriptionRepository },
    { provide: HOST_RESOLVER, useValue: systemResolver },
    {
      provide: CONFIG_WRITER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): ConfigWriter => new FileConfigWriter(config.xray.configPath),
    },
    {
      provide: SubscriptionRoutes,
      inject: [SUBSCRIPTION_REPOSITORY, SETTINGS_READER, APP_CONFIG],
      useFactory: (repository: SubscriptionRepository, settings: SettingsReader, config: AppConfig): SubscriptionRoutes =>
        new SubscriptionRoutes({ repository, settings, host: config.xray.host, basePort: config.xray.socksPortBase }),
    },
    ProxyRoutes,
    { provide: OUTBOUND_ROUTES, useExisting: ProxyRoutes },
    {
      provide: SubscriptionSync,
      inject: [SUBSCRIPTION_REPOSITORY, PROXY_CIPHER, Outbound, HOST_RESOLVER, CONFIG_WRITER, SubscriptionRoutes, REDIS, ProxyRoutes, APP_CONFIG],
      useFactory: (
        repository: SubscriptionRepository,
        cipher: SecretCipher | null,
        outbound: Outbound,
        resolve: HostResolver,
        writer: ConfigWriter,
        routes: SubscriptionRoutes,
        redis: Redis,
        proxyRoutes: ProxyRoutes,
        config: AppConfig,
      ): SubscriptionSync =>
        new SubscriptionSync({
          repository,
          cipher,
          outbound,
          resolve,
          writer,
          routes,
          redis,
          changed: () => proxyRoutes.changed("subscription"),
          xray: { basePort: config.xray.socksPortBase, slotCount: config.xray.slotCount },
        }),
    },
    {
      provide: SubscriptionScheduler,
      inject: [SUBSCRIPTION_REPOSITORY, SubscriptionRoutes, SubscriptionSync, OUTBOUND_PROXY_FETCH, REDIS, SETTINGS_READER, ProxyRoutes, APP_CONFIG],
      useFactory: (
        repository: SubscriptionRepository,
        routes: SubscriptionRoutes,
        sync: SubscriptionSync,
        proxyFetch: ProxyFetch,
        redis: Redis,
        settings: SettingsReader,
        proxyRoutes: ProxyRoutes,
        config: AppConfig,
      ): SubscriptionScheduler => {
        // Без базы подписке негде жить: расписание не запускается (как опрос прокси).
        return new SubscriptionScheduler({ repository, routes, sync, proxyFetch, redis, settings, changed: () => proxyRoutes.changed("subscription"), autostart: config.databaseUrl !== "" });
      },
    },
    ProxySubscriptionService,
    ProxiesService,
  ],
  exports: [OUTBOUND_ROUTES, ProxiesService, ProxySubscriptionService],
})
export class ProxiesModule {}
