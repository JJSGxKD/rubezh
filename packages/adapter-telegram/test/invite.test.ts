import { afterEach, describe, expect, it, vi } from "vitest";
import { inviteFromBrowser, sharePreparedWith } from "../src/invite";

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

describe("сообщение от бота", () => {
  const sdk = (available: boolean, share: () => Promise<void>) => ({ isAvailable: () => available, share });

  it("открыт выбор чата и сообщение ушло — «отправлено»", async () => {
    const shared: string[] = [];
    expect(await sharePreparedWith(sdk(true, async () => void shared.push("x")), "msg-1")).toBe("shared");
    expect(shared).toEqual(["x"]);
  });

  it("клиент старше 8.0 или браузер — «не вышло», и окно не открывается", async () => {
    let opened = false;
    expect(await sharePreparedWith(sdk(false, async () => void (opened = true)), "msg-1")).toBe("unavailable");
    expect(opened).toBe(false);
  });

  it("игрок сам закрыл окно — «отменено», а не сбой; прочая ошибка — «не вышло»", async () => {
    const declined = new Error("USER_DECLINED");
    declined.name = "ShareMessageError";
    expect(await sharePreparedWith(sdk(true, async () => Promise.reject(declined)), "msg-1")).toBe("cancelled");
    expect(await sharePreparedWith(sdk(true, async () => Promise.reject(new Error("MESSAGE_EXPIRED"))), "msg-1")).toBe("unavailable");
  });
});

