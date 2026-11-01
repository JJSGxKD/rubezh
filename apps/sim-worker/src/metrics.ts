import { createServer } from "node:http";

/**
 * Метрики воркера в формате Prometheus (docs/22-analytics-and-metrics.md): свой
 * текст в 60 строк вместо библиотеки — метрик две, а новая зависимость в
 * процессе, который ничего другого не делает, не окупается. Метки —
 * только очередь и исход: никаких номеров проверок и черновиков
 * (низкая кардинальность).
 *
 * - `sim_jobs_total{queue,outcome}` — задания по исходу;
 * - `sim_job_seconds{queue}` — время задания, гистограмма.
 */

export const OUTCOMES = ["ok", "invalid", "timeout", "error"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Границы корзин, с: предел задания — 120 с, последняя корзина — он. */
const BUCKETS = [1, 5, 10, 30, 60, 90, 120] as const;

interface Histogram {
  /** накопительные: корзина считает всё, что не больше её границы */
  buckets: number[];
  sum: number;
  count: number;
}

export class Metrics {
  private readonly jobs = new Map<string, number>();
  private readonly seconds = new Map<string, Histogram>();

  observe(queue: string, outcome: Outcome, seconds: number): void {
    if (!OUTCOMES.includes(outcome)) throw new Error(`Неизвестный исход задания: ${String(outcome)}`);
    const key = `${queue}\0${outcome}`;
    this.jobs.set(key, (this.jobs.get(key) ?? 0) + 1);
    const histogram = this.seconds.get(queue) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((bound, index) => {
      if (seconds <= bound) histogram.buckets[index] = (histogram.buckets[index] ?? 0) + 1;
    });
    histogram.sum += seconds;
    histogram.count += 1;
    this.seconds.set(queue, histogram);
  }

  render(): string {
    const lines = ["# HELP sim_jobs_total Задания воркера симуляции по исходу.", "# TYPE sim_jobs_total counter"];
    for (const [key, value] of this.jobs) {
      const [queue = "", outcome = ""] = key.split("\0");
      lines.push(`sim_jobs_total{queue="${queue}",outcome="${outcome}"} ${String(value)}`);
    }
    lines.push("# HELP sim_job_seconds Время задания воркера симуляции, с.", "# TYPE sim_job_seconds histogram");
    for (const [queue, histogram] of this.seconds) {
      BUCKETS.forEach((bound, index) => lines.push(`sim_job_seconds_bucket{queue="${queue}",le="${String(bound)}"} ${String(histogram.buckets[index] ?? 0)}`));
      lines.push(`sim_job_seconds_bucket{queue="${queue}",le="+Inf"} ${String(histogram.count)}`);
      lines.push(`sim_job_seconds_sum{queue="${queue}"} ${String(histogram.sum)}`);
      lines.push(`sim_job_seconds_count{queue="${queue}"} ${String(histogram.count)}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

/** Запущенный сервер метрик: порт (при нуле его выбирает система) и остановка. */
export interface MetricsServer {
  port: number;
  close: () => Promise<void>;
}

/**
 * Сервер метрик: `/metrics` для Prometheus и `/health` для проверки
 * контейнера. Ничего другого он не отдаёт и ничего не принимает.
 */
export async function startMetricsServer(port: number, host: string, metrics: Metrics): Promise<MetricsServer> {
  const server = createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" }).end();
      return;
    }
    if (request.url === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" }).end(metrics.render());
      return;
    }
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ok");
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
