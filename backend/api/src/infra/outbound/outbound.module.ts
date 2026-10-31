import { Global, Module } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../redis.js";
import { NOOP_SINK, Outbound, OUTBOUND_SINK, type OutboundSink } from "./outbound.js";
import { OUTBOUND_PROXY_FETCH, OUTBOUND_ROUTE_MEMORY, type RouteMemory } from "./outbound-route.js";
import { undiciProxyFetch } from "./proxy-dispatcher.js";
import { RedisRouteMemory } from "./route-memory.js";

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
 *
 * Список прокси и режимы сервисов (`OUTBOUND_ROUTES`) даёт модуль прокси
 * (`modules/proxies`, tasks/T-0065), как приёмник — модуль журнала: без него
 * клиент ходит напрямую. Память о сработавшем прокси — в Redis, если он есть.
 */
@Global()
@Module({
  providers: [
    {
      provide: OUTBOUND_SINK,
      inject: [{ token: APP_OUTBOUND_SINK, optional: true }],
      useFactory: (sink: OutboundSink | undefined): OutboundSink => sink ?? NOOP_SINK,
    },
    {
      provide: OUTBOUND_ROUTE_MEMORY,
      inject: [{ token: REDIS, optional: true }],
      useFactory: (redis: Redis | undefined): RouteMemory | undefined => (redis === undefined ? undefined : new RedisRouteMemory(redis)),
    },
    { provide: OUTBOUND_PROXY_FETCH, useValue: undiciProxyFetch },
    Outbound,
  ],
  exports: [Outbound, OUTBOUND_SINK, OUTBOUND_PROXY_FETCH],
})
export class OutboundModule {}
