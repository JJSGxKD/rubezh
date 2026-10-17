import { describe, expect, it } from "vitest";
import { checkSubscriptionUrl, isPublicAddress } from "../src/url-guard.js";

// Адрес подписки задаёт человек, а запрос идёт из сети сервера: без защиты
// это способ достучаться до внутренних сервисов (SSRF).

function reasonOf(raw: string): string {
  const result = checkSubscriptionUrl(raw);
  if (result.ok) throw new Error(`ожидался отказ: ${raw}`);
  return result.reason;
}

describe("адрес подписки", () => {
  it("разрешён: https с публичным именем или публичным IP", () => {
    for (const raw of ["https://example.com/sub?token=x", "https://203.0.113.10/sub", "https://sub.example.com:8443/a/b", "https://[2606:4700::1111]/sub"]) {
      const result = checkSubscriptionUrl(raw);
      expect(result.ok, raw).toBe(true);
      if (result.ok) expect(result.url).toBeInstanceOf(URL);
    }
  });

  it("не https — scheme", () => {
    expect(reasonOf("http://example.com/sub")).toBe("scheme");
    expect(reasonOf("ftp://example.com/sub")).toBe("scheme");
    expect(reasonOf("file:///etc/passwd")).toBe("scheme");
  });

  it("логин и пароль в адресе — credentials", () => {
    expect(reasonOf("https://user:pass@example.com/sub")).toBe("credentials");
    expect(reasonOf("https://user@example.com/sub")).toBe("credentials");
  });

  it("не адрес — malformed", () => {
    expect(reasonOf("не адрес")).toBe("malformed");
    expect(reasonOf("")).toBe("malformed");
  });

  it("закрытые имена и адреса — host", () => {
    const blocked = [
      "https://localhost/sub",
      "https://app.localhost/sub",
      "https://sub.local/sub",
      "https://db.internal/sub",
      "https://router.lan/sub",
      "https://redis/sub",
      "https://postgres:5432/sub",
      "https://10.0.0.5/sub",
      "https://192.168.1.1/sub",
      "https://127.0.0.1/sub",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/sub",
      "https://[::ffff:127.0.0.1]/sub",
      "https://[fe80::1]/sub",
      "https://[fd00::1]/sub",
      "https://0.0.0.0/sub",
    ];
    for (const raw of blocked) expect(reasonOf(raw), raw).toBe("host");
  });

  it("десятичная и шестнадцатеричная запись IP не обходит проверку", () => {
    // WHATWG URL нормализует их в 127.0.0.1.
    expect(reasonOf("https://2130706433/sub")).toBe("host");
    expect(reasonOf("https://0x7f000001/sub")).toBe("host");
  });
});

describe("публичный ли адрес", () => {
  it("границы диапазонов IPv4", () => {
    const cases: [string, boolean][] = [
      ["0.0.0.0", false],
      ["0.255.255.255", false],
      ["1.0.0.0", true],
      ["9.255.255.255", true],
      ["10.0.0.0", false],
      ["10.255.255.255", false],
      ["11.0.0.0", true],
      ["100.63.255.255", true],
      ["100.64.0.0", false],
      ["100.127.255.255", false],
      ["100.128.0.0", true],
      ["126.255.255.255", true],
      ["127.0.0.1", false],
      ["169.253.255.255", true],
      ["169.254.0.0", false],
      ["169.255.0.0", true],
      ["172.15.255.255", true],
      ["172.16.0.0", false],
      ["172.31.255.255", false],
      ["172.32.0.0", true],
      ["192.0.0.1", false],
      ["192.0.1.1", true],
      ["192.167.255.255", true],
      ["192.168.0.1", false],
      ["192.169.0.0", true],
      ["198.17.255.255", true],
      ["198.18.0.0", false],
      ["198.19.255.255", false],
      ["198.20.0.0", true],
      ["223.255.255.255", true],
      ["224.0.0.1", false],
      ["240.0.0.1", false],
      ["255.255.255.255", false],
      ["203.0.113.10", true],
    ];
    for (const [ip, expected] of cases) expect(isPublicAddress(ip), ip).toBe(expected);
  });

  it("IPv6 и ::ffff:a.b.c.d", () => {
    const cases: [string, boolean][] = [
      ["::", false],
      ["::1", false],
      ["fc00::1", false],
      ["fdff::1", false],
      ["fe80::1", false],
      ["febf::1", false],
      ["ff02::1", false],
      ["2001:db8::1", false],
      ["2001:db9::1", true],
      ["2606:4700::1111", true],
      ["::ffff:127.0.0.1", false],
      ["::ffff:10.0.0.1", false],
      ["::ffff:203.0.113.10", true],
    ];
    for (const [ip, expected] of cases) expect(isPublicAddress(ip), ip).toBe(expected);
  });

  it("не адрес — не публичный", () => {
    for (const value of ["", "example.com", "999.1.1.1", "1.2.3", "::gggg"]) expect(isPublicAddress(value), value).toBe(false);
  });
});
