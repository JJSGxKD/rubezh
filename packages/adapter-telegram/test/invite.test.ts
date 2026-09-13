import { afterEach, describe, expect, it, vi } from "vitest";
import { inviteFromBrowser } from "../src/invite";

// Приглашение в игру вне Telegram: системный лист, иначе копия ссылки
// (docs/27-design-system-and-app-shell.md §6, «Друзья»).

const INVITE = { url: "https://t.me/rubezh_bot?startapp=invite", text: "Заходи в Рубеж" };

describe("приглашение вне Telegram", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("открывает системный лист «поделиться», если браузер его даёт", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share });

    await expect(inviteFromBrowser(INVITE)).resolves.toBe("shared");
    expect(share).toHaveBeenCalledWith({ url: INVITE.url, text: INVITE.text });
  });

  it("отмену листа игроком не считает ошибкой и не копирует ссылку за его спиной", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", {
      share: vi.fn().mockRejectedValue(new DOMException("отмена", "AbortError")),
      clipboard: { writeText },
    });

    await expect(inviteFromBrowser(INVITE)).resolves.toBe("shared");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("без листа копирует текст со ссылкой", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(inviteFromBrowser(INVITE)).resolves.toBe("copied");
    expect(writeText).toHaveBeenCalledWith(`${INVITE.text} ${INVITE.url}`);
  });

  it("честно сообщает, что не вышло, если нет ни листа, ни доступа к буферу", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("нет фокуса")) },
    });
    await expect(inviteFromBrowser(INVITE)).resolves.toBe("unavailable");

    vi.stubGlobal("navigator", {});
    await expect(inviteFromBrowser(INVITE)).resolves.toBe("unavailable");
  });
});
