import { z } from "zod";

/**
 * Конфигурация воркера (docs/20-env-and-ports.md §7): Zod-схема на всё
 * окружение, невалидное — процесс не поднимается. Секретов здесь нет: воркер
 * ходит только в Redis внутри сети, и адрес без пароля — обычное дело в compose.
 *
 * Порт метрик — из карты портов, `docs/20` §2: dev `4010`, staging `4110`, в
 * проде наружу не публикуется. В контейнере метрики слушают все интерфейсы:
 * Prometheus приходит из сети compose, а наружу порт не проброшен.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  REDIS_URL: z
    .string()
    .regex(/^rediss?:\/\//, "Адрес Redis — redis:// или rediss://")
    .default("redis://localhost:6379"),
  SIM_WORKER_METRICS_PORT: z.coerce.number().int().min(1).max(65_535).default(4010),
});

export interface SimWorkerConfig {
  redisUrl: string;
  metricsPort: number;
  metricsHost: string;
  production: boolean;
}

/** `process.env` читается только здесь: остальной код получает готовый конфиг. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SimWorkerConfig {
  const parsed = envSchema.parse(env);
  const production = parsed.NODE_ENV === "production";
  return {
    redisUrl: parsed.REDIS_URL,
    metricsPort: parsed.SIM_WORKER_METRICS_PORT,
    metricsHost: production ? "0.0.0.0" : "127.0.0.1",
    production,
  };
}
