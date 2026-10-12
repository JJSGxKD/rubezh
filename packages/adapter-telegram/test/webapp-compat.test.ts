import { describe, expect, it } from "vitest";
import type { LinkSdk } from "../src/links";
import { compareVersions, compatLinks, installTelegramWebAppCompat } from "../src/webapp-compat";

// Прослойка `Telegram.WebApp` для сторонних SDK (src/webapp-compat.ts).

function links(patch: Partial<LinkSdk> = {}) {
  const calls: string[] = [];
  const sdk: LinkSdk = {
    telegramAvailable: () => true,
    openTelegram: (url) => void calls.push(`telegram ${url}`),
    linkAvailable: () => true,
    open: (url) => void calls.push(`link ${url}`),
    browser: (url) => void calls.push(`browser ${url}`),
    ...patch,
  };
  return { compat: compatLinks(sdk), calls };
}

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

  // Без этих методов Taddy считает объект урезанным и грузит официальный
  // скрипт с telegram.org, который политика источников не пускает.
  it("ссылки чужого SDK — путём адаптера: канал в клиенте, страница во встроенном браузере", () => {
    const { compat, calls } = links();
    compat.openTelegramLink("https://t.me/rubezh_game");
    compat.openLink("https://example.com/partner");
    compat.openLink("https://t.me/rubezh_game");
    expect(calls).toEqual(["telegram https://t.me/rubezh_game", "link https://example.com/partner", "telegram https://t.me/rubezh_game"]);
  });

  it("openTelegramLink с чужой ссылкой не бросает, а открывает её; без моста — окно браузера", () => {
    const { compat, calls } = links();
    compat.openTelegramLink("https://example.com/partner");
    expect(calls).toEqual(["link https://example.com/partner"]);

    const outside = links({ telegramAvailable: () => false, linkAvailable: () => false });
    outside.compat.openTelegramLink("https://t.me/rubezh_game");
    expect(outside.calls).toEqual(["browser https://t.me/rubezh_game"]);
  });
});
