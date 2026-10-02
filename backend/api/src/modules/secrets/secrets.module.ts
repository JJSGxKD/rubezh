import { Global, Module } from "@nestjs/common";
import { PrismaSecretsRepository, SECRETS_REPOSITORY } from "./secrets.repository.js";
import { SECRETS_READER, SecretsService } from "./secrets.service.js";

/**
 * Ключи интеграций (WP46, docs/35-stage4-plan.md Р84).
 *
 * Модуль глобальный, как настройки: ключи читают модули домена и адаптеры
 * площадок. Права, проверка вида и аудит записи — в панели
 * (`admin-secrets.service.ts`), здесь только хранение и чтение.
 */
@Global()
@Module({
  providers: [SecretsService, { provide: SECRETS_READER, useExisting: SecretsService }, { provide: SECRETS_REPOSITORY, useClass: PrismaSecretsRepository }],
  exports: [SecretsService, SECRETS_READER],
})
export class SecretsModule {}
