import { Global, Module } from "@nestjs/common";
import { NOOP_SINK, Outbound, OUTBOUND_SINK, type OutboundSink } from "./outbound.js";

/**
 * Приёмник клиента в приложении: его даёт модуль журнала запросов
 * (`modules/request-journal`, tasks/T-0060). Токен здесь, а не там, чтобы
 * инфраструктура не зависела от доменного модуля.
 */
export const APP_OUTBOUND_SINK = Symbol("APP_OUTBOUND_SINK");

/**
 * Единый клиент исходящих запросов для всего бэкенда. Приёмник по умолчанию
 * пустой — так клиент работает в тестах и там, где модуля журнала нет; в
 * приложении журнал подставляет свой через `APP_OUTBOUND_SINK`.
 */
@Global()
@Module({
  providers: [
    {
      provide: OUTBOUND_SINK,
      inject: [{ token: APP_OUTBOUND_SINK, optional: true }],
      useFactory: (sink: OutboundSink | undefined): OutboundSink => sink ?? NOOP_SINK,
    },
    Outbound,
  ],
  exports: [Outbound, OUTBOUND_SINK],
})
export class OutboundModule {}
