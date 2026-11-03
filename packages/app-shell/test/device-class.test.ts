import { describe, expect, it } from "vitest";
import { deviceClassOf, type DeviceEnvironment } from "../src/state/device";

// Класс устройства для подстройки давления (tasks/T-0196, решение 4, Р67):
// слабое — не десктоп и (памяти не больше 2 ГБ или ядер не больше 4). Нет
// сведений — обычное: лучше не урезать бой зря.

const ANDROID = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

function env(patch: Partial<DeviceEnvironment>): DeviceEnvironment {
  return { userAgent: ANDROID, maxTouchPoints: 5, screenWidth: 412, screenHeight: 915, pixelRatio: 2.6, cores: 8, memoryGb: 4, ...patch };
}

describe("класс устройства", () => {
  const cases: [string, DeviceEnvironment, "standard" | "light"][] = [
    ["Android, 8 ядер, 4 ГБ", env({}), "standard"],
    ["Android, 8 ядер, 2 ГБ", env({ memoryGb: 2 }), "light"],
    ["Android, 4 ядра, память неизвестна", env({ cores: 4, memoryGb: null }), "light"],
    ["Android, 6 ядер, память неизвестна", env({ cores: 6, memoryGb: null }), "standard"],
    ["iPhone, 6 ядер", env({ userAgent: IPHONE, screenWidth: 390, screenHeight: 844, cores: 6, memoryGb: null }), "standard"],
    ["iPhone, 2 ядра", env({ userAgent: IPHONE, screenWidth: 375, screenHeight: 667, cores: 2, memoryGb: null }), "light"],
    ["iPad, 8 ядер", env({ userAgent: IPAD, screenWidth: 820, screenHeight: 1180, cores: 8, memoryGb: null }), "standard"],
    ["Windows с мышью, 2 ядра, 2 ГБ", env({ userAgent: WINDOWS, maxTouchPoints: 0, screenWidth: 1920, screenHeight: 1080, pixelRatio: 1, cores: 2, memoryGb: 2 }), "standard"],
    ["пустые сведения", env({ userAgent: "", maxTouchPoints: 0, screenWidth: 0, screenHeight: 0, pixelRatio: 1, cores: null, memoryGb: null }), "standard"],
  ];

  it.each(cases)("%s — %s", (_name, environment, expected) => {
    expect(deviceClassOf(environment)).toBe(expected);
  });
});
