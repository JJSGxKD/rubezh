import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

// Конфигурация воркера (docs/20-env-and-ports.md §7): Zod-схема, невалидное
// окружение — процесс не поднимается; порт метрик — из карты портов.

describe("конфигурация sim-worker", () => {
  it("пустое окружение — умолчания из карты портов и локальный Redis", () => {
    expect(loadConfig({})).toEqual({ redisUrl: "redis://localhost:6379", metricsPort: 4010, metricsHost: "127.0.0.1", production: false });
  });

  it("порт метрик и адрес Redis берутся из окружения", () => {
    const config = loadConfig({ SIM_WORKER_METRICS_PORT: "4110", REDIS_URL: "redis://redis:6379" });
    expect(config.metricsPort).toBe(4110);
    expect(config.redisUrl).toBe("redis://redis:6379");
  });

  it("в проде метрики слушают все интерфейсы контейнера: порт наружу не публикуется, снимает их Prometheus из сети compose", () => {
    expect(loadConfig({ NODE_ENV: "production" })).toMatchObject({ metricsHost: "0.0.0.0", production: true });
  });

  it.each(["0", "65536", "abc", "40.5", "-1"])("порт метрик «%s» — отказ при старте", (port) => {
    expect(() => loadConfig({ SIM_WORKER_METRICS_PORT: port })).toThrow();
  });

  it("адрес Redis не по схеме redis — отказ", () => {
    expect(() => loadConfig({ REDIS_URL: "http://redis:6379" })).toThrow();
  });
});
