import { Redis } from "ioredis";
import type { AppConfig } from "../config/app-config.js";

/**
 * Соединения BullMQ (docs/16-tech-stack-decisions.md §5). У очередей свои
 * соединения, не общий клиент из `redis.ts`: воркер держит блокирующее чтение
 * и обязан ждать Redis сколько угодно, а производитель в запросе игрока —
 * наоборот, отказывать сразу, чтобы приёмник успел записать в базу напрямую.
 */
export function createQueueConnection(config: AppConfig, role: "producer" | "worker"): Redis {
  if (role === "worker") {
    // Требование BullMQ для воркеров: без null команды блокирующего чтения
    // падали бы на первом же обрыве связи.
    return new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
  }
  return new Redis(config.redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 2_000,
    commandTimeout: 2_000,
    maxRetriesPerRequest: 1,
  });
}
