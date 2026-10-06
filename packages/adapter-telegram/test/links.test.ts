import { describe, expect, it, vi } from "vitest";
import { isTelegramLink, openLinkWith, type LinkSdk } from "../src/links";

// Внешние ссылки из Mini App (docs/35-stage4-plan.md Р52): канал Telegram —
// внутри клиента, остальное — встроенным браузером, а без моста — обычным
// окном. Кнопка не должна молча не срабатывать.

function sdk(patch: Partial<LinkSdk> = {}) {
  const calls: string[] = [];
  const fake: LinkSdk = {
    telegramAvailable: () => true,
    openTelegram: (url) => void calls.push(`telegram ${url}`),
    linkAvailable: () => true,
    open: (url) => void calls.push(`link ${url}`),
    browser: (url) => void calls.push(`browser ${url}`),
    ...patch,
  };
  return { fake, calls };
}

describe("ссылки из Telegram", () => {
  it("ссылка Telegram — только https на t.me или telegram.me", () => {
    expect(isTelegramLink("https://t.me/rubezh_game")).toBe(true);
    expect(isTelegramLink("https://telegram.me/rubezh_game")).toBe(true);
    expect(isTelegramLink("http://t.me/rubezh_game")).toBe(false);
    expect(isTelegramLink("https://t.me.evil.example/x")).toBe(false);
    expect(isTelegramLink("tg://resolve?domain=x")).toBe(false);
    expect(isTelegramLink("не ссылка")).toBe(false);
  });

  it("канал открывается в клиенте, страница — во встроенном браузере", () => {
    const { fake, calls } = sdk();
    openLinkWith(fake, "https://t.me/rubezh_game");
    openLinkWith(fake, "https://example.com/partner");
    expect(calls).toEqual(["telegram https://t.me/rubezh_game", "link https://example.com/partner"]);
  });

  it("старый клиент без openTelegramLink — встроенный браузер; вне клиента — окно браузера", () => {
    const old = sdk({ telegramAvailable: () => false });
    openLinkWith(old.fake, "https://t.me/rubezh_game");
    expect(old.calls).toEqual(["link https://t.me/rubezh_game"]);

    const outside = sdk({ telegramAvailable: () => false, linkAvailable: () => false });
    openLinkWith(outside.fake, "https://t.me/rubezh_game");
    expect(outside.calls).toEqual(["browser https://t.me/rubezh_game"]);
  });

  it("сбой моста — окно браузера, а не тишина", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = sdk({
      openTelegram: () => {
        throw new Error("ConcurrentCallError");
      },
    });
    openLinkWith(broken.fake, "https://t.me/rubezh_game");
    expect(broken.calls).toEqual(["browser https://t.me/rubezh_game"]);
    warn.mockRestore();
  });
});
