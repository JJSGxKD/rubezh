import { Module } from "@nestjs/common";
import { SECRETS_READER, type SecretsReader } from "../secrets/secrets.service.js";
import { ConversionsJournal } from "./conversions-journal.service.js";
import { CONVERSIONS_REPOSITORY, PrismaConversionsRepository } from "./conversions.repository.js";
import { AdConversionsService } from "./conversions.service.js";
import { AdsgramDestination } from "./destinations/adsgram.destination.js";
import { POSTBACK_DESTINATIONS, type PostbackDestination } from "./destinations/destination.js";

/**
 * Конверсии закупленной рекламы (WP43, docs/35-stage4-plan.md Р86): вывод
 * из фактов, отправка постбэком назначениям, журнал для панели. Новое
 * назначение — адаптер в `POSTBACK_DESTINATIONS` и ветка набора в
 * `destinations/destination-targets.ts`.
 */
@Module({
  providers: [
    AdConversionsService,
    ConversionsJournal,
    { provide: CONVERSIONS_REPOSITORY, useClass: PrismaConversionsRepository },
    {
      provide: POSTBACK_DESTINATIONS,
      useFactory: (secrets: SecretsReader): PostbackDestination[] => [new AdsgramDestination(secrets)],
      inject: [SECRETS_READER],
    },
  ],
  exports: [ConversionsJournal],
})
export class AdConversionsModule {}
