import { Global, Module } from "@nestjs/common";
import { NOOP_SINK, Outbound, OUTBOUND_SINK } from "./outbound.js";

/**
 * Единый клиент исходящих запросов для всего бэкенда. Приёмник пока пустой:
 * журнал запросов подключит свой провайдер `OUTBOUND_SINK` (tasks/T-0060).
 */
@Global()
@Module({
  providers: [{ provide: OUTBOUND_SINK, useValue: NOOP_SINK }, Outbound],
  exports: [Outbound, OUTBOUND_SINK],
})
export class OutboundModule {}
