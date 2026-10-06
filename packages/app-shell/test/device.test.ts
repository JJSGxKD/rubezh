import { describe, expect, it, vi } from "vitest";
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

describe("сведения на ходу", () => {
  it("смена окна и плотности зовёт пересчёт, отписка снимает слушателей", async () => {
    const { watchEnvironment } = await import("../src/state/device");
    const window = new EventTarget();
    const queries: EventTarget[] = [];
    vi.stubGlobal("addEventListener", window.addEventListener.bind(window));
    vi.stubGlobal("removeEventListener", window.removeEventListener.bind(window));
    vi.stubGlobal("matchMedia", () => {
      const query = new EventTarget();
      queries.push(query);
      return query;
    });
    let calls = 0;
    const stop = watchEnvironment(() => {
      calls++;
    });

    window.dispatchEvent(new Event("resize"));
    expect(calls).toBe(1);
    // Плотность сменилась — окно на другом мониторе: пересчёт и новый запрос.
    queries[0]?.dispatchEvent(new Event("change"));
    expect(calls).toBe(2);
    expect(queries).toHaveLength(2);

    stop();
    window.dispatchEvent(new Event("resize"));
    queries[1]?.dispatchEvent(new Event("change"));
    expect(calls).toBe(2);
    vi.unstubAllGlobals();
  });
});
