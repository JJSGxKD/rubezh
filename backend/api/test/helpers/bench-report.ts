/** Отчёт стресс-теста в том виде, в каком его шлёт оболочка. */

export const REPORT_ID = "11111111-2222-4333-8444-555555555555";

const frame = { frames: 600, durationSec: 10, avgFps: 58.37, minFps: 31, p50FrameMs: 16.6, p95FrameMs: 21.44, p99FrameMs: 30, over33Ratio: 0 };

export const DEVICE = {
  clientPlatform: "android",
  clientVersion: "8.0",
  os: "android",
  formFactor: "phone",
  screenWidth: 412,
  screenHeight: 915,
  pixelRatio: 2.63,
  cores: 8,
  memoryGb: 8,
} as const;

export function benchSubmission(reportId = REPORT_ID): Record<string, unknown> {
  return {
    reportId,
    report: {
      schema: "rubezh.bench.v4",
      startedAt: "2026-09-14T12:00:00.000Z",
      stoppedBy: "degradation",
      interruptions: 0,
      profile: { mode: "stress", targetPopulation: 4000, addPerSecond: 20, seed: 1, durationSec: 300, buildVersion: "0.3.0", canvasWidth: 1080, canvasHeight: 2400, devicePixelRatio: 2.63, renderer: "WEBGL", loadout: "full" },
      device: { userAgent: "ua", platform: "Linux", hardwareConcurrency: 8, deviceMemoryGb: 8, screenWidth: 412, screenHeight: 915, devicePixelRatio: 2.63, telegramPlatform: "android", telegramVersion: "8.0", telegramUserId: "777000111", telegramLanguage: "ru", telegramIsPremium: false, telegramFullscreen: true },
      totals: { ...frame, over20Ratio: 0.1, degradationRatio: 0.2, peakLoad: 900.4, peakProjectiles: 310, peakObjects: 1210.6, displayHz: 60 },
      windows: [],
      timeline: [
        { ...frame, index: 0, startSec: 0, load: 100, projectiles: 20 },
        { ...frame, index: 1, startSec: 5, load: 400, projectiles: 120, avgFps: 57 },
        { ...frame, index: 2, startSec: 10, load: 660, projectiles: 250, avgFps: 44, p95FrameMs: 26 },
      ],
    },
    verdict: { level: "no-go", sustainedLoad: 640, breakingPoint: { atSec: 32, load: 660.2, avgFps: 44, p95FrameMs: 26 }, failures: [] },
  };
}

export function reportEnvelope(reportId = REPORT_ID, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reportId,
    kind: "bench",
    appVersion: "0.4.0",
    contentHash: "abc123",
    installId: "0f6f1f5e-1111-4222-8333-444455556666",
    platform: "telegram",
    occurredAt: "2026-09-14T12:00:00.000Z",
    device: DEVICE,
    payload: benchSubmission(reportId),
    ...patch,
  };
}
