import { describe, expect, it } from "vitest";
import { compareVersions, installTelegramWebAppCompat } from "../src/webapp-compat";

// Прослойка `Telegram.WebApp` для сторонних SDK (src/webapp-compat.ts).

describe("прослойка Telegram.WebApp", () => {
  it("сравнивает версии по частям числами, а не строкой", () => {
    expect(compareVersions("8.0", "7.10")).toBe(1);
    expect(compareVersions("7.10", "7.9")).toBe(1);
    expect(compareVersions("7.7", "7.7.0")).toBe(0);
    expect(compareVersions("6.9", "7.0")).toBe(-1);
  });

  it("без окна браузера — ничего не ставит и не падает", () => {
    expect(installTelegramWebAppCompat()).toBeNull();
  });
});
