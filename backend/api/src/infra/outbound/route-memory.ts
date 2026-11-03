import type { Redis } from "ioredis";
import { ROUTE_MEMORY_SEC, type RouteMemory } from "./outbound-route.js";

/** Ключ памяти о маршруте сервиса. Значение — id прокси, без адреса и пароля. */
export const routeKey = (service: string): string => `outbound:route:${service}`;

/**
 * Память о том, через какой прокси сервис прошёл в последний раз
 * (docs/35-stage4-plan.md Р91): десять минут этот прокси пробуется первым,
 * лишний таймаут на каждом вызове не нужен. Подсказка, а не учёт: недоступный
 * Redis клиент переживает и без неё.
 */
export class RedisRouteMemory implements RouteMemory {
  constructor(private readonly redis: Redis) {}

  async get(service: string): Promise<string | null> {
    return await this.redis.get(routeKey(service));
  }

  async remember(service: string, proxyId: string): Promise<void> {
    await this.redis.set(routeKey(service), proxyId, "EX", ROUTE_MEMORY_SEC);
  }
}
