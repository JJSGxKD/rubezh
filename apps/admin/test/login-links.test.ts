import { describe, expect, it } from "vitest";
import { loginLinks } from "../src/screens/login-links";

// Вход в панель (docs/29-admin-panel.md §8, Р100): QR — обычная https-ссылка,
// потому что камеры Android не открывают tg://; кнопка — диплинк сразу в
// приложение.

const LINK = "https://t.me/rubezh_bot?start=panel-X";
const DEEP = "tg://resolve?domain=rubezh_bot&start=panel-X";

describe("ссылки страницы входа", () => {
  it("QR и запасная ссылка — link, кнопка — deepLink", () => {
    expect(loginLinks({ link: LINK, deepLink: DEEP })).toEqual({ qr: LINK, button: DEEP, fallback: LINK });
  });

  it("deepLink нет (null) — кнопка ведёт по link", () => {
    expect(loginLinks({ link: LINK, deepLink: null })).toEqual({ qr: LINK, button: LINK, fallback: LINK });
  });

  it("deepLink не пришёл вовсе (старый сервер) — кнопка ведёт по link", () => {
    expect(loginLinks({ link: LINK })).toEqual({ qr: LINK, button: LINK, fallback: LINK });
  });

  it("QR начинается с https:// при любом deepLink", () => {
    for (const deepLink of [DEEP, null, undefined]) {
      expect(loginLinks({ link: LINK, deepLink }).qr.startsWith("https://")).toBe(true);
    }
  });
});
