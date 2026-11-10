import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_LOOKUP_TIMEOUT_MS, checkHost, isInternalAddress, isInternalHostname } from "../src/modules/ad-conversions/destinations/public-address.js";
import { templateProblems } from "../src/modules/ad-conversions/destinations/postback-template.js";

/**
 * Внутренние адреса (tasks/T-0070): постбэк уходит на адрес, который вводят люди, поэтому по нему
 * нельзя достать до сети сервера — ни прямым IP, ни именем, которое во внутренний IP разрешается.
 * Проверка стоит дважды: при сохранении (по имени) и при отправке (по тому, во что оно разрешается).
 */

const INTERNAL = [
  "0.0.0.0",
  "10.1.2.3",
  "100.64.0.1",
  "127.0.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.1",
  "198.18.0.1",
  "224.0.0.1",
  "255.255.255.255",
  "::",
  "::1",
  "fc00::1",
  "fd12::1",
  "fe80::1",
  "ff02::1",
  "::ffff:127.0.0.1",
  "::ffff:10.0.0.1",
];

const PUBLIC = ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.63.255.255", "2606:4700:4700::1111", "::ffff:8.8.8.8"];

describe("isInternalAddress", () => {
  it.each(INTERNAL)("внутренний: %s", (ip) => {
    expect(isInternalAddress(ip)).toBe(true);
  });

  it.each(PUBLIC)("публичный: %s", (ip) => {
    expect(isInternalAddress(ip)).toBe(false);
  });

  it("границы диапазонов: 172.15 и 172.32 публичные, 172.16 и 172.31 внутренние; 100.127 внутренний, 100.128 публичный", () => {
    expect(isInternalAddress("172.15.255.255")).toBe(false);
    expect(isInternalAddress("172.16.0.0")).toBe(true);
    expect(isInternalAddress("172.31.255.255")).toBe(true);
    expect(isInternalAddress("172.32.0.0")).toBe(false);
    expect(isInternalAddress("100.127.255.255")).toBe(true);
    expect(isInternalAddress("100.128.0.0")).toBe(false);
  });

  it("документация, тестовые сети, зарезервированное и многоадресное", () => {
    for (const ip of ["192.0.2.1", "198.51.100.7", "203.0.113.9", "198.19.255.255", "240.0.0.1", "239.255.255.255", "192.0.0.1"]) {
      expect(isInternalAddress(ip), ip).toBe(true);
    }
    for (const ip of ["2001:db8::1", "64:ff9b:1::1", "100::1", "fec0::1", "ff00::1"]) {
      expect(isInternalAddress(ip), ip).toBe(true);
    }
  });

  it("IPv4 внутри IPv6 проверяется по вложенному адресу: v4-mapped в любой записи, NAT64, 6to4", () => {
    expect(isInternalAddress("::ffff:7f00:1")).toBe(true);
    expect(isInternalAddress("0:0:0:0:0:ffff:a00:1")).toBe(true);
    expect(isInternalAddress("::ffff:808:808")).toBe(false);
    expect(isInternalAddress("64:ff9b::7f00:1")).toBe(true);
    expect(isInternalAddress("64:ff9b::808:808")).toBe(false);
    expect(isInternalAddress("2002:7f00:1::")).toBe(true);
    expect(isInternalAddress("2002:808:808::")).toBe(false);
    // Совместимый с IPv4 вид (устарел) — всегда внутренний.
    expect(isInternalAddress("::7f00:1")).toBe(true);
  });

  it("скобки и зона отбрасываются или считаются внутренними; мусор — внутренний (отказ по умолчанию)", () => {
    expect(isInternalAddress("[::1]")).toBe(true);
    expect(isInternalAddress("fe80::1%eth0")).toBe(true);
    expect(isInternalAddress("")).toBe(true);
    expect(isInternalAddress("не адрес")).toBe(true);
    expect(isInternalAddress("1.2.3")).toBe(true);
    expect(isInternalAddress("300.1.1.1")).toBe(true);
    expect(isInternalAddress("1:2:3:4:5:6:7:8:9")).toBe(true);
  });
});

describe("isInternalHostname", () => {
  it("имена, внутренние сами по себе: localhost, *.localhost, *.local, *.internal, *.lan, *.home.arpa, имя без точки", () => {
    for (const host of ["localhost", "LOCALHOST", "localhost.", "app.localhost", "printer.local", "meta.internal", "router.lan", "nas.home.arpa", "intranet", "db"]) {
      expect(isInternalHostname(host), host).toBe(true);
    }
  });

  it("публичные имена не задеты: похожие окончания и поддомены", () => {
    for (const host of ["track.example.com", "example.com", "localhost.example.com", "mylocal.com", "internal.example.org", "lan.example.com", "a.b.example.co.uk"]) {
      expect(isInternalHostname(host), host).toBe(false);
    }
  });

  it("IP-литералы: внутренний — внутреннее имя, публичный — нет; IPv6 в скобках", () => {
    expect(isInternalHostname("127.0.0.1")).toBe(true);
    expect(isInternalHostname("10.0.0.5")).toBe(true);
    expect(isInternalHostname("8.8.8.8")).toBe(false);
    expect(isInternalHostname("[::1]")).toBe(true);
    expect(isInternalHostname("::1")).toBe(true);
    expect(isInternalHostname("[2606:4700:4700::1111]")).toBe(false);
  });

  it("числовые записи IPv4 (десятичная, шестнадцатеричная, короткая) читаются как адрес, а не как имя", () => {
    expect(isInternalHostname("2130706433")).toBe(true);
    expect(isInternalHostname("0x7f000001")).toBe(true);
    expect(isInternalHostname("127.1")).toBe(true);
    expect(isInternalHostname("0177.0.0.1")).toBe(true);
    // 134744072 = 8.8.8.8: публичный адрес числом всё равно не имя сайта, но и не внутренняя сеть.
    expect(isInternalHostname("134744072")).toBe(false);
  });
});

describe("«Адрес указывает на внутреннюю сеть» при сохранении", () => {
  const MESSAGE = ["Адрес указывает на внутреннюю сеть"];

  it.each(["https://localhost/p", "https://127.0.0.1/p", "https://[::1]/p", "https://2130706433/p", "https://10.0.0.5/p", "https://meta.internal/p", "https://printer.local/p", "https://intranet/p"])(
    "%s",
    (address) => {
      expect(templateProblems(address)).toEqual(MESSAGE);
    },
  );

  it("публичный IP-литерал и имя годятся", () => {
    expect(templateProblems("https://8.8.8.8/p")).toEqual([]);
    expect(templateProblems("https://[2606:4700:4700::1111]/p")).toEqual([]);
    expect(templateProblems("https://track.example.com/p")).toEqual([]);
  });
});

describe("checkHost", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("публичный IP в ответе — ok", async () => {
    expect(await checkHost("track.example.com", async () => ["93.184.216.34"])).toEqual({ ok: true });
    expect(await checkHost("track.example.com", async () => ["93.184.216.34", "2606:4700:4700::1111"])).toEqual({ ok: true });
  });

  it("хоть один внутренний среди ответов — отказ без повтора: подмена DNS", async () => {
    const result = await checkHost("evil.example.com", async () => ["93.184.216.34", "169.254.169.254"]);
    expect(result).toMatchObject({ ok: false, retry: false });
    expect(result.ok ? "" : result.message).toContain("внутренн");
    expect(await checkHost("evil.example.com", async () => ["::ffff:127.0.0.1"])).toMatchObject({ ok: false, retry: false });
    expect(await checkHost("evil.example.com", async () => ["10.0.0.1"])).toMatchObject({ ok: false, retry: false });
  });

  it("пустой ответ и «имя не найдено» — отказ с повтором: DNS мог сбойнуть", async () => {
    expect(await checkHost("track.example.com", async () => [])).toMatchObject({ ok: false, retry: true });
    const notFound = Object.assign(new Error("getaddrinfo ENOTFOUND track.example.com"), { code: "ENOTFOUND" });
    expect(await checkHost("track.example.com", async () => Promise.reject(notFound))).toMatchObject({ ok: false, retry: true });
    expect(await checkHost("track.example.com", async () => Promise.reject(new Error("сбой")))).toMatchObject({ ok: false, retry: true });
  });

  it("ответ позже 3 секунд — отказ с повтором", async () => {
    vi.useFakeTimers();
    expect(HOST_LOOKUP_TIMEOUT_MS).toBe(3_000);
    const pending = checkHost("slow.example.com", () => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(HOST_LOOKUP_TIMEOUT_MS + 1);
    expect(await pending).toMatchObject({ ok: false, retry: true });
  });

  it("быстрый ответ не ждёт таймера", async () => {
    vi.useFakeTimers();
    const pending = checkHost("fast.example.com", async () => ["93.184.216.34"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: true });
  });

  it("IP-литерал разрешать не нужно: проверяется сам, поиск имени не вызывается", async () => {
    const lookup = vi.fn(async () => ["93.184.216.34"]);
    expect(await checkHost("8.8.8.8", lookup)).toEqual({ ok: true });
    expect(await checkHost("[2606:4700:4700::1111]", lookup)).toEqual({ ok: true });
    expect(await checkHost("127.0.0.1", lookup)).toMatchObject({ ok: false, retry: false });
    expect(await checkHost("[::1]", lookup)).toMatchObject({ ok: false, retry: false });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("внутреннее имя отказывает сразу, без поиска: правила ужесточились после сохранения", async () => {
    const lookup = vi.fn(async () => ["93.184.216.34"]);
    expect(await checkHost("meta.internal", lookup)).toMatchObject({ ok: false, retry: false });
    expect(await checkHost("localhost", lookup)).toMatchObject({ ok: false, retry: false });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("ответ с мусором вместо адреса считается внутренним", async () => {
    expect(await checkHost("track.example.com", async () => ["не-адрес"])).toMatchObject({ ok: false, retry: false });
  });
});
