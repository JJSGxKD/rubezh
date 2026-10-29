import { Redis } from "ioredis";
import { loadConfig } from "./config";
import { logEvent } from "./log";
import { Metrics, startMetricsServer } from "./metrics";
import { createCheckWorker } from "./queue";

/**
 * Точка входа sim-worker (docs/35-stage4-plan.md Р15, tasks/T-0302): свой
 * процесс со своей сборкой движка. Берёт задания очереди `content-check`,
 * отдаёт метрики и останавливается по сигналу, дождавшись текущего задания.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const metrics = new Metrics();
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const server = await startMetricsServer(config.metricsPort, config.metricsHost, metrics);
  const worker = createCheckWorker({ connection, metrics });
  logEvent("log", "started", { metricsPort: server.port });

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logEvent("log", "stopping", { signal });
    // Текущее задание дорабатывает: закрытие воркера ждёт его конца.
    await worker.close();
    await server.close();
    connection.disconnect();
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
}

main().catch((error: unknown) => {
  logEvent("error", "start_failed", { reason: error instanceof Error ? error.message : "unknown" });
  process.exitCode = 1;
});
