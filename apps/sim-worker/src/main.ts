import { Redis } from "ioredis";
import { loadConfig } from "./config";
import { logEvent, logThrottled } from "./log";
import { Metrics, startMetricsServer } from "./metrics";
import { createCheckWorker } from "./queue";
import { createReplayWorker, RunGate } from "./replay-job";

/**
 * Точка входа sim-worker (docs/35-stage4-plan.md Р15, tasks/T-0302, T-0318): свой
 * процесс со своей сборкой движка. Берёт задания очередей `content-check` и
 * `replay`, отдаёт метрики и останавливается по сигналу, дождавшись текущих
 * заданий. Тяжёлая работа идёт по одной на процесс: воркеры делят затвор, и
 * проверка контента, которую ждёт человек в панели, идёт раньше повтора забега.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const metrics = new Metrics();
  const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  // Без обработчика ошибка соединения — необработанное событие; клиент переподключается сам.
  connection.on("error", (error: Error) => logThrottled("warn", "redis_error", { reason: error.message }));
  const server = await startMetricsServer(config.metricsPort, config.metricsHost, metrics);
  const gate = new RunGate();
  const workers = [createCheckWorker({ connection, metrics, gate }), createReplayWorker({ connection, metrics, gate })];
  logEvent("log", "started", { metricsPort: server.port });

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logEvent("log", "stopping", { signal });
    // Текущее задание дорабатывает: закрытие воркера ждёт его конца.
    await Promise.all(workers.map((worker) => worker.close()));
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
