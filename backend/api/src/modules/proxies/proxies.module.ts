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
import { SubscriptionCommands } from "./subscription/subscription-commands.js";
import { HOST_RESOLVER, systemResolver, type HostResolver } from "./subscription/subscription-download.js";
import { SubscriptionRoutes } from "./subscription/subscription-routes.js";
import { SUBSCRIPTION_REPOSITORY, PrismaSubscriptionRepository, type SubscriptionRepository } from "./subscription/subscription.repository.js";
import { SubscriptionScheduler } from "./subscription/subscription.scheduler.js";
import { ProxySubscriptionService } from "./subscription/subscription.service.js";
import { SubscriptionSync } from "./subscription/subscription.sync.js";
import { TrafficCollector } from "./subscription/traffic/traffic.collector.js";
import { PrismaTrafficRepository, TRAFFIC_REPOSITORY, type TrafficRepository } from "./subscription/traffic/traffic.repository.js";
import { TrafficService } from "./subscription/traffic/traffic.service.js";
import { Http2StatsSource, STATS_SOURCE, type StatsSource } from "./subscription/traffic/xray-stats.client.js";
import { CONFIG_WRITER, FileConfigWriter, type ConfigWriter } from "./subscription/xray-config-writer.js";

/**
 * Прокси для исходящих запросов (docs/35-stage4-plan.md Р91, tasks/T-0065) и
 * подписки Xray (Р101, Р192, tasks/T-0093, tasks/T-0384) с учётом их трафика
 * (Р192, tasks/T-0386).
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
    { provide: TRAFFIC_REPOSITORY, useClass: PrismaTrafficRepository },
    {
      provide: STATS_SOURCE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): StatsSource => new Http2StatsSource({ host: config.xray.host, port: config.xray.statsPort }),
    },
    {
      provide: TrafficCollector,
      inject: [STATS_SOURCE, TRAFFIC_REPOSITORY, SUBSCRIPTION_REPOSITORY, APP_CONFIG],
      // Без базы счётчикам негде жить: таймер не запускается (как расписание подписок).
      useFactory: (source: StatsSource, repository: TrafficRepository, subscriptions: SubscriptionRepository, config: AppConfig): TrafficCollector =>
        new TrafficCollector({ source, repository, subscriptions, autostart: config.databaseUrl !== "" }),
    },
    TrafficService,
    {
      provide: SubscriptionSync,
      inject: [SUBSCRIPTION_REPOSITORY, PROXY_CIPHER, Outbound, HOST_RESOLVER, CONFIG_WRITER, SubscriptionRoutes, REDIS, ProxyRoutes, APP_CONFIG, TrafficCollector],
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
        traffic: TrafficCollector,
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
          xray: { basePort: config.xray.socksPortBase, slotCount: config.xray.slotCount, statsPort: config.xray.statsPort },
          beforeWrite: () => traffic.flush(),
        }),
    },
    {
      provide: SubscriptionScheduler,
      inject: [SUBSCRIPTION_REPOSITORY, SubscriptionRoutes, SubscriptionSync, CONFIG_WRITER, OUTBOUND_PROXY_FETCH, REDIS, SETTINGS_READER, ProxyRoutes, APP_CONFIG],
      useFactory: (
        repository: SubscriptionRepository,
        routes: SubscriptionRoutes,
        sync: SubscriptionSync,
        writer: ConfigWriter,
        proxyFetch: ProxyFetch,
        redis: Redis,
        settings: SettingsReader,
        proxyRoutes: ProxyRoutes,
        config: AppConfig,
      ): SubscriptionScheduler => {
        // Без базы подписке негде жить: расписание не запускается (как опрос прокси).
        return new SubscriptionScheduler({ repository, routes, sync, writer, proxyFetch, redis, settings, changed: () => proxyRoutes.changed("subscription"), autostart: config.databaseUrl !== "" });
      },
    },
    {
      provide: SubscriptionCommands,
      inject: [SUBSCRIPTION_REPOSITORY, CONFIG_WRITER, SubscriptionSync, APP_CONFIG],
      useFactory: (repository: SubscriptionRepository, writer: ConfigWriter, sync: SubscriptionSync, config: AppConfig): SubscriptionCommands =>
        new SubscriptionCommands({ repository, writer, sync, xray: { slotCount: config.xray.slotCount } }),
    },
    ProxySubscriptionService,
    ProxiesService,
  ],
  exports: [OUTBOUND_ROUTES, ProxiesService, ProxySubscriptionService, TrafficService],
})
export class ProxiesModule {}
