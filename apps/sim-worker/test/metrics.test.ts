import { afterEach, describe, expect, it } from "vitest";
import { Metrics, startMetricsServer } from "../src/metrics";

// Метрики воркера (tasks/T-0302): `sim_jobs_total{queue,outcome}` и
// `sim_job_seconds{queue}`; только низкая кардинальность — без номера проверки.

describe("метрики в формате Prometheus", () => {
  it("счётчик по исходам и гистограмма времени; метки — только очередь и исход", () => {
    const metrics = new Metrics();
    metrics.observe("content-check", "ok", 3);
    metrics.observe("content-check", "ok", 70);
    metrics.observe("content-check", "timeout", 120);

    const text = metrics.render();

    expect(text).toContain("# TYPE sim_jobs_total counter");
    expect(text).toContain('sim_jobs_total{queue="content-check",outcome="ok"} 2');
    expect(text).toContain('sim_jobs_total{queue="content-check",outcome="timeout"} 1');
    expect(text).toContain("# TYPE sim_job_seconds histogram");
    expect(text).toContain('sim_job_seconds_bucket{queue="content-check",le="5"} 1');
    expect(text).toContain('sim_job_seconds_bucket{queue="content-check",le="120"} 3');
    expect(text).toContain('sim_job_seconds_bucket{queue="content-check",le="+Inf"} 3');
    expect(text).toContain('sim_job_seconds_sum{queue="content-check"} 193');
    expect(text).toContain('sim_job_seconds_count{queue="content-check"} 3');
    expect(text).not.toMatch(/checkId|check_id/);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("корзины накопительные: каждая считает всё, что не больше её границы", () => {
    const metrics = new Metrics();
    metrics.observe("q", "ok", 0.5);
    const lines = metrics.render().split("\n").filter((line) => line.startsWith("sim_job_seconds_bucket"));
    const counts = lines.map((line) => Number(line.split(" ")[1]));
    expect(counts.every((count) => count === 1)).toBe(true);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  it("до первого задания — только справка и тип: пустой ответ тоже валидный", () => {
    const text = new Metrics().render();
    expect(text).toContain("# HELP sim_jobs_total");
    expect(text).not.toContain("sim_jobs_total{");
  });

  it("неизвестный исход не заводит новую метку: значение берётся из закрытого перечня", () => {
    const metrics = new Metrics();
    expect(() => metrics.observe("q", "что-то новое" as never, 1)).toThrow();
  });
});

describe("сервер метрик", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it("/metrics — текст Prometheus, /health — «ok», остальное — 404, не GET — 405", async () => {
    const metrics = new Metrics();
    metrics.observe("content-check", "ok", 1);
    const server = await startMetricsServer(0, "127.0.0.1", metrics);
    closers.push(server.close);
    const base = `http://127.0.0.1:${String(server.port)}`;

    const scraped = await fetch(`${base}/metrics`);
    expect(scraped.status).toBe(200);
    expect(scraped.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(await scraped.text()).toContain('sim_jobs_total{queue="content-check",outcome="ok"} 1');

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok");

    expect((await fetch(`${base}/other`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`, { method: "POST" })).status).toBe(405);
  });
});
