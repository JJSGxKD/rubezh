import { Global, Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { NOOP_SINK, type OutboundSink } from "../../infra/outbound/outbound.js";
import { APP_OUTBOUND_SINK } from "../../infra/outbound/outbound.module.js";
import { InboundCounter } from "./inbound-counter.js";
import { JournalRollup } from "./journal.rollup.js";
import { BufferedOutboundSink } from "./outbound-sink.js";
import { PrismaRequestJournalRepository, REQUEST_JOURNAL_REPOSITORY } from "./request-journal.repository.js";

/**
 * Журнал запросов — хранение (docs/35-stage4-plan.md Р92, tasks/T-0060):
 * исходящие вызовы клиента строкой на попытку, входящие сводкой по маршрутам за
 * минуту, семь суток. Читает журнал раздел «Запросы» панели (tasks/T-0061).
 *
 * Модуль глобальный: клиент исходящих (`OutboundModule`) берёт приёмник из
 * `APP_OUTBOUND_SINK`, не зная о журнале, а `http-app.ts` находит счётчик по
 * классу. Без базы приёмник приложения — пустой: писать некуда, а буфер
 * копил бы записи впустую.
 */
@Global()
@Module({
  providers: [
    { provide: REQUEST_JOURNAL_REPOSITORY, useClass: PrismaRequestJournalRepository },
    BufferedOutboundSink,
    InboundCounter,
    JournalRollup,
    {
      provide: APP_OUTBOUND_SINK,
      inject: [APP_CONFIG, BufferedOutboundSink],
      useFactory: (config: AppConfig, sink: BufferedOutboundSink): OutboundSink => (config.databaseUrl === "" ? NOOP_SINK : sink),
    },
  ],
  exports: [APP_OUTBOUND_SINK, InboundCounter],
})
export class RequestJournalModule {}
