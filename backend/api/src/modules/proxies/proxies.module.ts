import { Global, Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { OUTBOUND_ROUTES } from "../../infra/outbound/outbound-route.js";
import { SecretCipher } from "../secrets/secret-cipher.js";
import { ProxiesService } from "./proxies.service.js";
import { PROXIES_REPOSITORY, PrismaProxiesRepository } from "./proxies.repository.js";
import { PROXY_CIPHER } from "./proxy-password.js";
import { ProxyRoutes } from "./proxy-routes.service.js";

/**
 * Прокси для исходящих запросов (docs/35-stage4-plan.md Р91, tasks/T-0065).
 *
 * Модуль глобальный, как приёмник журнала запросов: клиент исходящих
 * (`infra/outbound`) берёт список прокси и режимы из `OUTBOUND_ROUTES`, не
 * зная о доменном модуле, а без базы остаётся прямой путь. Права, проверка
 * формы и аудит — в `ProxiesService` и контроллере панели.
 *
 * Шифр пароля тот же, что у ключей интеграций (`SECRETS_ENCRYPTION_KEY`); без
 * ключа или без базы пароль прокси сохранить нельзя, прокси без пароля работают.
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
    ProxyRoutes,
    { provide: OUTBOUND_ROUTES, useExisting: ProxyRoutes },
    ProxiesService,
  ],
  exports: [OUTBOUND_ROUTES, ProxiesService],
})
export class ProxiesModule {}
