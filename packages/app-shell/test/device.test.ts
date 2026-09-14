import { describe, expect, it } from "vitest";
import { describeDevice, osOf, type DeviceEnvironment } from "../src/state/device";

// Сведения об устройстве для статистики плейтеста: семейство ОС и тип
// устройства вместо строки user-agent.

function env(patch: Partial<DeviceEnvironment>): DeviceEnvironment {
  return { userAgent: "", maxTouchPoints: 5, screenWidth: 390, screenHeight: 844, pixelRatio: 3, cores: 8, memoryGb: 4, ...patch };
}

describe("устройство", () => {
  it("узнаёт семейство ОС, в том числе iPad, притворяющийся маком", () => {
    expect(osOf("Mozilla/5.0 (Linux; Android 14; Pixel 8)", 5)).toBe("android");
    expect(osOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)", 5)).toBe("ios");
    expect(osOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe("ios");
    expect(osOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe("macos");
    expect(osOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", 0)).toBe("windows");
  });

  it("отличает телефон от планшета по короткой стороне, а компьютер — по отсутствию касаний", () => {
    const client = { platform: "android", version: "8.0" };
    expect(describeDevice(client, env({ userAgent: "Android" })).formFactor).toBe("phone");
    expect(describeDevice(client, env({ userAgent: "Android", screenWidth: 800, screenHeight: 1280 })).formFactor).toBe("tablet");
    expect(describeDevice({ platform: "tdesktop", version: null }, env({ userAgent: "Windows NT", maxTouchPoints: 0 })))
      .toMatchObject({ os: "windows", formFactor: "desktop", clientPlatform: "tdesktop" });
  });

  it("не отправляет строку user-agent — только разбор", () => {
    const device = describeDevice({ platform: "ios", version: "8.0" }, env({ userAgent: "iPhone; secret build 123" }));
    expect(JSON.stringify(device)).not.toContain("secret");
  });
});
