import { describe, expect, it } from "vitest";
import { buildDeviceReport, deviceModel, estimateDisplayHz, formatDeviceReport } from "../src/state/device-report";
import { hasTranslation } from "../src/i18n";
import "../src/i18n/team";

// Сведения об устройстве для баг-репорта (docs/28-diagnostics.md §2.2).

const SAMSUNG = "Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36";
const REDUCED = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

describe("модель устройства из user-agent", () => {
  it("достаёт модель и версию Android из WebView Telegram", () => {
    expect(deviceModel(SAMSUNG)).toBe("SM-S918B, Android 14");
  });

  it("не выдаёт заглушку урезанного user-agent за модель", () => {
    expect(deviceModel(REDUCED)).toBe("Android 10");
  });

  it("узнаёт iPhone и версию iOS", () => {
    expect(deviceModel(IPHONE)).toBe("iPhone, iOS 17.5.1");
  });

  it("на неизвестной строке честно не знает", () => {
    expect(deviceModel("curl/8.0")).toBeNull();
  });
});

describe("частота экрана", () => {
  it("берёт медиану: долгий кадр на открытии не сбивает оценку", () => {
    const intervals = [...Array.from({ length: 60 }, () => 8.33), 250, 40];
    expect(estimateDisplayHz(intervals)).toBe(120);
  });

  it("не отвечает по горстке кадров", () => {
    expect(estimateDisplayHz([16.6, 16.7, 16.6])).toBeNull();
  });
});

describe("текст для команды", () => {
  const rows = buildDeviceReport({
    build: "0.4.0",
    contentHash: "abc123",
    installId: "0f6f1f5e-1111-4222-8333-444455556666",
    client: { platform: "android", version: "8.0" },
    env: { userAgent: SAMSUNG, maxTouchPoints: 5, screenWidth: 412, screenHeight: 915, pixelRatio: 2.625, cores: 8, memoryGb: 8 },
    viewport: { width: 412, height: 780 },
    insets: { top: 24, right: 0, bottom: 16, left: 0 },
    screenMode: "fullscreen",
    displayHz: 60,
  });

  it("содержит всё, по чему баг сопоставляют с устройством", () => {
    const text = formatDeviceReport(rows, (key) => key);
    expect(text).toContain("install: 0f6f1f5e-1111-4222-8333-444455556666");
    expect(text).toContain("model: SM-S918B, Android 14");
    expect(text).toContain("client: android 8.0");
    // Канва — в физических пикселях окна, а не экрана.
    expect(text).toContain("canvas: 1082×2048");
    expect(text).toContain("displayHz: ≈60");
    expect(text).toContain("insets: 24 / 0 / 16 / 0");
  });

  it("у каждой строки есть подпись в словаре команды", () => {
    for (const row of rows) expect(hasTranslation(`diagnostics.report.${row.key}`), row.key).toBe(true);
  });
});
