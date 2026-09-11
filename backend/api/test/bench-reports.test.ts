import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig, type AppConfig } from "../src/config/app-config";
import { BenchReportsRepository } from "../src/modules/bench-reports/bench-reports.repository";
import { BenchReportsService } from "../src/modules/bench-reports/bench-reports.service";
import { BenchTokenGuard } from "../src/modules/bench-reports/bench-token.guard";
import { submitBenchReportSchema } from "../src/modules/bench-reports/dto/bench-report.dto";
import { DomainError } from "../src/common/domain-error";

// Хранилище настоящее — временный каталог на диске, а не мок файловой
// системы: проверяется именно поведение «создать, если не существует»,
// а мок воспроизводил бы наши представления о нём
// (docs/17-testing-strategy.md §4.2).

let directory: string;
let config: AppConfig;
let service: BenchReportsService;

function submission(overrides: { reportId?: string; avgFps?: number; level?: string } = {}) {
  const frameStats = {
    frames: 10_800,
    durationSec: 180,
    avgFps: overrides.avgFps ?? 60,
    minFps: 42,
    p50FrameMs: 16.6,
    p95FrameMs: 17.2,
    p99FrameMs: 22.1,
    over33Ratio: 0.001,
  };

  return {
    reportId: overrides.reportId ?? "11111111-2222-4333-8444-555555555555",
    report: {
      schema: "rubezh.bench.v2",
      startedAt: "2026-09-10T12:00:00.000Z",
      profile: {
        mode: "ramp" as const,
        targetPopulation: 480,
        addPerSecond: 2,
        seed: 42,
        durationSec: 180,
        buildVersion: "0.1.0",
        canvasWidth: 1080,
        canvasHeight: 1920,
        devicePixelRatio: 3,
        renderer: "WEBGL",
      },
      device: {
        userAgent: "Mozilla/5.0 (Linux; Android 13)",
        platform: "Linux armv8l",
        hardwareConcurrency: 8,
        deviceMemoryGb: 4,
        screenWidth: 1080,
        screenHeight: 2400,
        devicePixelRatio: 3,
        telegramPlatform: "android",
        telegramVersion: "7.10",
        telegramUserId: "1001",
        telegramLanguage: "ru",
        telegramIsPremium: false,
        telegramFullscreen: false,
      },
      totals: { ...frameStats, over20Ratio: 0.01, degradationRatio: 0.03, peakLoad: 380 },
      windows: [{ ...frameStats, index: 0, startSec: 0, avgLoad: 120, maxLoad: 200 }],
      timeline: [{ ...frameStats, index: 0, startSec: 0, load: 120 }],
    },
    verdict: {
      level: (overrides.level ?? "go") as "go" | "no-go" | "invalid",
      sustainedLoad: 260,
      breakingPoint: null,
      failures: [],
    },
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "bench-reports-"));
  config = loadAppConfig({
    BENCH_INGEST_ENABLED: "true",
    BENCH_INGEST_TOKEN: "test-token",
    BENCH_REPORTS_DIR: directory,
  } as NodeJS.ProcessEnv);
  service = new BenchReportsService(new BenchReportsRepository(config));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("конфигурация", () => {
  it("не даёт включить приёмник без токена", () => {
    expect(() =>
      loadAppConfig({ BENCH_INGEST_ENABLED: "true" } as NodeJS.ProcessEnv),
    ).toThrow(/BENCH_INGEST_TOKEN/);
  });

  it("разбирает список разрешённых origin, игнорируя пробелы и пустые записи", () => {
    const parsed = loadAppConfig({
      ALLOWED_ORIGINS: "https://a.example, ,https://b.example ",
    } as NodeJS.ProcessEnv);

    expect(parsed.allowedOrigins).toEqual(["https://a.example", "https://b.example"]);
  });
});

describe("разбор отчёта", () => {
  it("принимает отчёт стенда", () => {
    expect(() => submitBenchReportSchema.parse(submission())).not.toThrow();
  });

  it("отклоняет ключ идемпотентности, который не UUID", () => {
    expect(() => submitBenchReportSchema.parse(submission({ reportId: "не-uuid" }))).toThrow();
  });

  it("отклоняет отчёт с невозможной долей просадок", () => {
    const broken = submission();
    broken.report.totals.over33Ratio = 42;
    expect(() => submitBenchReportSchema.parse(broken)).toThrow();
  });
});

describe("приём отчётов", () => {
  it("сохраняет отчёт и отдаёт его в списке", async () => {
    await service.submit(submitBenchReportSchema.parse(submission()));

    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0].verdict).toBe("go");
    expect(list[0].telegramPlatform).toBe("android");
  });

  it("не создаёт дубликат при повторной отправке того же прогона", async () => {
    const payload = submitBenchReportSchema.parse(submission());

    const first = await service.submit(payload);
    const second = await service.submit(payload);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(await service.list()).toHaveLength(1);
  });

  it("не теряет отчёт при одновременной отправке двух разных прогонов", async () => {
    await Promise.all([
      service.submit(submitBenchReportSchema.parse(submission({ reportId: "aaaaaaaa-1111-4111-8111-111111111111" }))),
      service.submit(submitBenchReportSchema.parse(submission({ reportId: "bbbbbbbb-2222-4222-8222-222222222222" }))),
    ]);

    expect(await service.list()).toHaveLength(2);
  });

  it("отдаёт пустой список, когда ни одного прогона ещё не было", async () => {
    await rm(directory, { recursive: true, force: true });
    expect(await service.list()).toEqual([]);
  });

  it("ограничивает размер списка", async () => {
    for (let i = 0; i < 5; i++) {
      await service.submit(
        submitBenchReportSchema.parse(
          submission({ reportId: `cccccccc-3333-4333-8333-00000000000${i}` }),
        ),
      );
    }

    expect(await service.list(2)).toHaveLength(2);
  });
});

describe("доступ к приёмнику", () => {
  function contextWith(headers: Record<string, string>, ip = "10.0.0.1") {
    const request = {
      ip,
      header: (name: string) => headers[name.toLowerCase()],
    };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as never;
  }

  it("прикидывается несуществующим, когда приёмник выключен", () => {
    const disabled = loadAppConfig({ BENCH_REPORTS_DIR: directory } as NodeJS.ProcessEnv);
    const guard = new BenchTokenGuard(disabled);

    expect(() => guard.canActivate(contextWith({ "x-bench-token": "test-token" }))).toThrow(
      expect.objectContaining({ code: "endpoint_disabled", status: 404 }) as DomainError,
    );
  });

  it("отклоняет запрос с чужим токеном", () => {
    const guard = new BenchTokenGuard(config);

    expect(() => guard.canActivate(contextWith({ "x-bench-token": "чужой" }))).toThrow(
      expect.objectContaining({ code: "unauthorized", status: 401 }) as DomainError,
    );
  });

  it("пропускает запрос с верным токеном", () => {
    const guard = new BenchTokenGuard(config);
    expect(guard.canActivate(contextWith({ "x-bench-token": "test-token" }))).toBe(true);
  });

  it("ограничивает частоту запросов с одного адреса", () => {
    const guard = new BenchTokenGuard(config);
    const context = contextWith({ "x-bench-token": "test-token" });

    for (let i = 0; i < 30; i++) guard.canActivate(context);

    expect(() => guard.canActivate(context)).toThrow(
      expect.objectContaining({ code: "rate_limited", status: 429 }) as DomainError,
    );
  });

  it("считает лимит по адресу, а не суммарно", () => {
    const guard = new BenchTokenGuard(config);
    for (let i = 0; i < 30; i++) {
      guard.canActivate(contextWith({ "x-bench-token": "test-token" }, "10.0.0.1"));
    }

    expect(guard.canActivate(contextWith({ "x-bench-token": "test-token" }, "10.0.0.2"))).toBe(
      true,
    );
  });
});
