import { describe, expect, it } from "vitest";
import { parseSubscription, parseUpdateIntervalHours, parseUserInfo, SubscriptionFormatError } from "../src/subscription.js";
import * as L from "./fixtures/links.js";

// Подписка: base64 (обычный или URL-safe, с «=» или без) от списка ссылок либо
// тот же список открытым текстом. Остальные форматы — отказ, а не догадка.

const LINKS = [L.VLESS_REALITY, L.VLESS_WS_TLS, L.VMESS_BASE64, L.TROJAN_GRPC, L.SS_SIP002];
const PLAIN = LINKS.join("\n");

describe("форматы тела", () => {
  it("открытый текст", () => {
    const parsed = parseSubscription(PLAIN);
    expect(parsed.format).toBe("plain");
    expect(parsed.nodes).toHaveLength(5);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.truncated).toBe(false);
  });

  it("base64 с «=», без «=» и URL-safe дают один и тот же результат", () => {
    const padded = Buffer.from(PLAIN, "utf8").toString("base64");
    const unpadded = padded.replace(/=+$/, "");
    const urlSafe = unpadded.replace(/\+/g, "-").replace(/\//g, "_");
    const reference = parseSubscription(PLAIN).nodes;

    for (const body of [padded, unpadded, urlSafe, `${padded}\n`]) {
      const parsed = parseSubscription(body);
      expect(parsed.format).toBe("base64");
      expect(parsed.nodes).toEqual(reference);
    }
  });

  it("\\r\\n, пустые строки, комментарии и строки без «://» пропускаются молча", () => {
    const body = ["# профиль", "", L.VLESS_WS_TLS, "REMARKS=что-то", "  ", L.TROJAN_GRPC, ""].join("\r\n");
    const parsed = parseSubscription(body);
    expect(parsed.nodes.map((node) => node.protocol)).toEqual(["vless", "trojan"]);
    expect(parsed.skipped).toEqual([]);
  });

  it("Clash YAML и JSON — unsupported_format", () => {
    for (const body of ["proxies:\n  - name: a\n    type: vless\n    server: example.com\n", JSON.stringify({ outbounds: [] }), JSON.stringify([{ outbounds: [] }])]) {
      expect(() => parseSubscription(body)).toThrow(SubscriptionFormatError);
      try {
        parseSubscription(body);
      } catch (error) {
        expect((error as SubscriptionFormatError).code).toBe("unsupported_format");
      }
    }
  });

  it("пустое тело и тело без единой ссылки — ошибка формата", () => {
    for (const body of ["", "  \n\n", "# только комментарий\n"]) {
      expect(() => parseSubscription(body), JSON.stringify(body)).toThrow(SubscriptionFormatError);
    }
    try {
      parseSubscription("");
    } catch (error) {
      expect((error as SubscriptionFormatError).code).toBe("empty");
    }
  });

  it("base64, внутри которого нет ссылок, — ошибка формата, а не пустой список", () => {
    const body = Buffer.from("просто текст без ссылок", "utf8").toString("base64");
    expect(() => parseSubscription(body)).toThrow(SubscriptionFormatError);
  });
});

describe("узлы и пропуски", () => {
  it("hysteria2:// попадает в skipped, остальные узлы целы; в пропуске номер строки, схема и причина", () => {
    const body = [L.VLESS_WS_TLS, "hysteria2://secret@example.com:443?obfs=x#h", L.TROJAN_GRPC].join("\n");
    const parsed = parseSubscription(body);
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.skipped).toEqual([{ index: 1, scheme: "hysteria2", reason: "unsupported_scheme", detail: "hysteria2" }]);
  });

  it("плохая ссылка не роняет остальные", () => {
    const body = ["vless://not-a-uuid@example.com:443", L.VLESS_WS_TLS].join("\n");
    const parsed = parseSubscription(body);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.skipped).toMatchObject([{ index: 0, scheme: "vless", reason: "malformed" }]);
  });

  it("одинаковая ссылка дважды — один узел; смена только названия — тот же ключ", () => {
    const renamed = L.VLESS_WS_TLS.replace("#WS%20node", "#Renamed");
    expect(parseSubscription([L.VLESS_WS_TLS, L.VLESS_WS_TLS].join("\n")).nodes).toHaveLength(1);
    expect(parseSubscription([L.VLESS_WS_TLS, renamed].join("\n")).nodes).toHaveLength(1);
    expect(parseSubscription(renamed).nodes[0]?.key).toBe(parseSubscription(L.VLESS_WS_TLS).nodes[0]?.key);
  });

  it("смена UUID — другой ключ", () => {
    const other = L.VLESS_WS_TLS.replace("11111111-1111", "22222222-1111");
    expect(parseSubscription(other).nodes[0]?.key).not.toBe(parseSubscription(L.VLESS_WS_TLS).nodes[0]?.key);
  });

  it("сверх maxLinks (1000) — truncated, разобрано ровно 1000", () => {
    const many = Array.from({ length: 1001 }, (_, i) => `trojan://pw${i}@example.com:443#n${i}`).join("\n");
    const parsed = parseSubscription(many);
    expect(parsed.truncated).toBe(true);
    expect(parsed.nodes).toHaveLength(1000);
  });

  it("свой потолок maxLinks", () => {
    const parsed = parseSubscription(PLAIN, { maxLinks: 2 });
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.truncated).toBe(true);
  });
});

describe("заголовки подписки", () => {
  it("Subscription-Userinfo", () => {
    expect(parseUserInfo("upload=1; download=2; total=3; expire=4")).toEqual({ uploadBytes: 1, downloadBytes: 2, totalBytes: 3, expireUnixSec: 4 });
    expect(parseUserInfo("download=2;total=3")).toEqual({ uploadBytes: null, downloadBytes: 2, totalBytes: 3, expireUnixSec: null });
  });

  it("мусор и пустой заголовок — null", () => {
    expect(parseUserInfo(null)).toBeNull();
    expect(parseUserInfo("")).toBeNull();
    expect(parseUserInfo("мусор без равно")).toBeNull();
    expect(parseUserInfo("upload=abc; download=-5")).toBeNull();
  });

  it("Profile-Update-Interval: часы от 1 до 168", () => {
    expect(parseUpdateIntervalHours("12")).toBe(12);
    expect(parseUpdateIntervalHours("1")).toBe(1);
    expect(parseUpdateIntervalHours("168")).toBe(168);
    for (const value of ["0", "169", "999", "abc", "", "1.5", "-3", null]) expect(parseUpdateIntervalHours(value), String(value)).toBeNull();
  });
});
