import { describe, expect, it } from "vitest";
import { adminOrigins, originOf, previewUrl } from "../vite/preview-origins";

/**
 * Адреса предпросмотра (docs/35-stage4-plan.md WP32): на dev-сервере всё
 * работает из коробки на петле, в сборке — только по явному адресу: угадать
 * боевой домен нельзя, а лишний адрес в политике — дыра.
 */
describe("адреса предпросмотра", () => {
  it("источник — схема, хост и порт; путь отбрасывается, битый адрес и чужая схема — null", () => {
    expect(originOf("https://admin.gonet.fun/#/home")).toBe("https://admin.gonet.fun");
    expect(originOf("http://127.0.0.1:5176")).toBe("http://127.0.0.1:5176");
    expect(originOf("")).toBeNull();
    expect(originOf("admin.gonet.fun")).toBeNull();
    expect(originOf("javascript:alert(1)")).toBeNull();
  });

  it("адрес панели: заданный — им; на dev-сервере без него — петля с портом панели; в сборке без него — никого", () => {
    expect(adminOrigins({ VITE_ADMIN_URL: "https://admin.gonet.fun/" }, false)).toEqual(["https://admin.gonet.fun"]);
    expect(adminOrigins({ ADMIN_PORT: "5176" }, true)).toEqual(["http://127.0.0.1:5176", "http://localhost:5176"]);
    expect(adminOrigins({}, false)).toEqual([]);
  });

  it("адрес страницы предпросмотра: заданный — им; на dev-сервере — петля с портом клиента, с сертификатом — https", () => {
    expect(previewUrl({ VITE_PREVIEW_URL: "https://tg.gonet.fun/preview/" }, false)).toBe("https://tg.gonet.fun/preview/");
    expect(previewUrl({ WEB_TELEGRAM_PORT: "5173" }, true)).toBe("http://127.0.0.1:5173/preview/");
    expect(previewUrl({ WEB_TELEGRAM_PORT: "5173", DEV_HTTPS_CERT: "cert.pem" }, true)).toBe("https://127.0.0.1:5173/preview/");
    expect(previewUrl({}, false)).toBe("");
  });
});
