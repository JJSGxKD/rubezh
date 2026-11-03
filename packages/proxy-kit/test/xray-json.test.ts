import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProxyNode } from "../src/node.js";
import { parseShareLink } from "../src/share-link.js";
import { parseSubscription, SubscriptionFormatError } from "../src/subscription.js";
import { buildXrayConfig } from "../src/xray-config.js";
import * as J from "./fixtures/xray-json.js";
import * as L from "./fixtures/links.js";

// JSON-подписки Xray: массив полных конфигов (`remarks` + `outbounds`) или один
// конфиг. Узел из выхода обязан совпадать с узлом из эквивалентной ссылки; чего
// не умеем — пропуск с той же причиной, что у ссылок; служебные выходы молчат.

const OPTIONS = { basePort: 10800, slotCount: 8, listen: "127.0.0.1" };

const parse = (value: unknown, options?: { maxLinks?: number }): ReturnType<typeof parseSubscription> => parseSubscription(JSON.stringify(value), options);

function nodeOfLink(link: string): ProxyNode {
  const result = parseShareLink(link);
  if (!result.ok) throw new Error(`ссылка не разобралась: ${result.reason}`);
  return result.node;
}

function formatCode(body: string): string {
  try {
    parseSubscription(body);
  } catch (error) {
    if (error instanceof SubscriptionFormatError) return error.code;
    throw error;
  }
  throw new Error("ожидалась ошибка формата");
}

/** Исходящее подключение узла без тега: ключ узла в тег входит, а сравниваем содержимое. */
function outboundOf(node: ProxyNode): Record<string, unknown> {
  const config = buildXrayConfig([node], new Map([[node.key, 0]]), OPTIONS) as { outbounds: Record<string, unknown>[] };
  return { ...config.outbounds[1], tag: "" };
}

describe("форматы JSON", () => {
  it("массив конфигов панели: имя узла — remarks, служебные выходы не узлы и не пропуски", () => {
    const body = readFileSync(new URL("./fixtures/xray-json/remnawave-array.json", import.meta.url), "utf8");
    const parsed = parseSubscription(body);

    expect(parsed.format).toBe("json");
    expect(parsed.nodes.map((node) => [node.name, node.protocol, node.host, node.country])).toEqual([
      ["🇩🇪 Germany", "vless", "203.0.113.10", "DE"],
      ["[NL] Netherlands", "vless", "nl.example.com", "NL"],
    ]);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.truncated).toBe(false);
  });

  it("один конфиг-объект; без remarks имя — хост:порт", () => {
    const parsed = parse(J.config(undefined, J.OUT_VLESS_WS_TLS));
    expect(parsed.format).toBe("json");
    expect(parsed.nodes.map((node) => node.name)).toEqual(["example.com:443"]);
  });

  it("BOM и пробелы до JSON не мешают", () => {
    const body = `﻿ \n${JSON.stringify([J.config("a", J.OUT_TROJAN_GRPC)])}\n`;
    expect(parseSubscription(body).nodes).toHaveLength(1);
  });

  it("remarks не декодируется как часть ссылки и чистится от управляющих знаков", () => {
    const parsed = parse([J.config("100%\u0007 fast %41", J.OUT_TROJAN_GRPC)]);
    expect(parsed.nodes[0]?.name).toBe("100% fast %41");
  });

  it("смесь протоколов в одном массиве; неподдерживаемый протокол — пропуск с причиной", () => {
    const hysteria = { tag: "proxy", protocol: "hysteria2", settings: { address: "h.example.org", port: 443 } };
    const parsed = parse([
      J.config("vless", J.OUT_VLESS_REALITY),
      J.config("vmess", J.OUT_VMESS_WS_TLS),
      J.config("hy", hysteria),
      J.config("trojan", J.OUT_TROJAN_GRPC),
      J.config("ss", J.OUT_SS_2022),
    ]);

    expect(parsed.nodes.map((node) => node.protocol)).toEqual(["vless", "vmess", "trojan", "shadowsocks"]);
    expect(parsed.skipped).toEqual([{ index: 2, scheme: "hysteria2", reason: "unsupported_scheme", detail: "hysteria2" }]);
  });

  it("несколько узлов в одном конфиге получают его remarks", () => {
    const parsed = parse(J.config("pair", [J.OUT_VLESS_WS_TLS, J.OUT_TROJAN_GRPC]));
    expect(parsed.nodes.map((node) => node.name)).toEqual(["pair", "pair"]);
  });

  it("один узел в двух конфигах — один узел, остаётся первое имя", () => {
    const parsed = parse([J.config("first", J.OUT_VLESS_WS_TLS), J.config("second", J.OUT_VLESS_WS_TLS)]);
    expect(parsed.nodes.map((node) => node.name)).toEqual(["first"]);
  });

  it("протокол без учёта регистра; порт строкой, как умеет Xray", () => {
    const outbound = J.patched(J.OUT_TROJAN_GRPC, { protocol: "Trojan", settings: { servers: [{ address: "example.com", port: "443", password: "p@ss" }] } });
    expect(parse(J.config("t", outbound)).nodes[0]).toMatchObject({ protocol: "trojan", port: 443 });
  });
});

describe("узел из JSON равен узлу из ссылки", () => {
  for (const [name, link, outbound] of J.PAIRS) {
    it(name, () => {
      const fromLink = nodeOfLink(link);
      const fromJson = parse([J.config(fromLink.name, outbound)]).nodes;

      expect(fromJson).toEqual([fromLink]);
      expect(outboundOf(fromJson[0] as ProxyNode)).toEqual(outboundOf(fromLink));
    });
  }

  it("без streamSettings — tcp без безопасности, как у ссылки без параметров", () => {
    const fromLink = nodeOfLink(`vless://${L.UUID}@example.com:443#x`);
    const outbound = { tag: "proxy", protocol: "vless", settings: { vnext: [{ address: "example.com", port: 443, users: [{ id: L.UUID }] }] } };
    expect(parse(J.config("x", outbound)).nodes).toEqual([fromLink]);
  });

  it("raw — новое имя tcp; пустое security — без безопасности; UUID в верхнем регистре", () => {
    const outbound = J.patched(J.OUT_VLESS_IPV6, {
      settings: { vnext: [{ address: "2001:db8::10", port: 443, users: [{ id: L.UUID.toUpperCase(), encryption: "none", flow: "" }] }] },
      streamSettings: { network: "raw", security: "" },
    });
    expect(parse(J.config("v6", outbound)).nodes).toEqual([nodeOfLink(L.VLESS_IPV6)]);
  });

  it("узел из JSON попадает в слот так же, как узел ссылки: ключ один", () => {
    const fromLink = nodeOfLink(L.VLESS_WS_TLS);
    expect(parse(J.config("другое имя", J.OUT_VLESS_WS_TLS)).nodes[0]?.key).toBe(fromLink.key);
  });
});

describe("пропуски", () => {
  const withTls = (patch: Record<string, unknown>): J.Json => J.withStream(J.OUT_VLESS_WS_TLS, { tlsSettings: { serverName: "cdn.example.com", ...patch } });
  const withReality = (patch: Record<string, unknown>): J.Json =>
    J.withStream(J.OUT_VLESS_REALITY, { realitySettings: { serverName: "www.example.com", publicKey: "PUBLICKEY1", ...patch } });
  const withVless = (patch: Record<string, unknown>, address = "example.com"): J.Json =>
    J.patched(J.OUT_VLESS_WS_TLS, { settings: { vnext: [{ address, port: 443, users: [{ id: L.UUID, encryption: "none", ...patch }] }] } });
  const withVmess = (patch: Record<string, unknown>): J.Json =>
    J.patched(J.OUT_VMESS_WS_TLS, { settings: { vnext: [{ address: "example.com", port: 443, users: [{ id: L.UUID, alterId: 0, security: "auto", ...patch }] }] } });
  const vnextEntry = (address: string): J.Json => ({ address, port: 443, users: [{ id: L.UUID }] });
  const withServer = (outbound: J.Json, patch: Record<string, unknown>): J.Json =>
    J.patched(outbound, { settings: { servers: [{ address: "example.com", port: 443, method: "aes-256-gcm", password: "pw", ...patch }] } });

  const CASES: [name: string, outbound: J.Json, reason: string, detail: string][] = [
    ["kcp", J.withStream(J.OUT_VLESS_WS_TLS, { network: "kcp" }), "unsupported_transport", "network"],
    ["tcp с http-заголовком", J.withStream(J.OUT_VLESS_REALITY, { tcpSettings: { header: { type: "http" } } }), "unsupported_option", "headerType"],
    ["allowInsecure", withTls({ allowInsecure: true }), "unsupported_option", "allowInsecure"],
    ["ECH", withTls({ echConfigList: "cloudflare-ech.com+https://1.1.1.1/dns-query" }), "unsupported_option", "ech"],
    ["закрепление сертификата", withTls({ pinnedPeerCertificateChainSha256: ["abc"] }), "unsupported_option", "pcs"],
    ["постквантовая подпись reality", withReality({ mldsa65Verify: "AAAA" }), "unsupported_option", "pqv"],
    ["безопасность xtls", J.withStream(J.OUT_VLESS_WS_TLS, { security: "xtls" }), "unsupported_option", "security"],
    ["flow, которого нет у ссылок", withVless({ flow: "xtls-rprx-vision-udp443" }), "unsupported_option", "flow"],
    ["постквантовое шифрование vless", withVless({ encryption: "mlkem768x25519plus.native.0rtt.AAAA" }), "unsupported_option", "encryption"],
    ["vmess alterId", withVmess({ alterId: 4 }), "unsupported_option", "aid"],
    ["цепочка через dialerProxy", J.withStream(J.OUT_VLESS_WS_TLS, { sockopt: { dialerProxy: "first-hop" } }), "unsupported_option", "dialerProxy"],
    ["цепочка через proxySettings", J.patched(J.OUT_VLESS_WS_TLS, { proxySettings: { tag: "first-hop" } }), "unsupported_option", "proxySettings"],
    ["два сервера в vnext", J.patched(J.OUT_VLESS_WS_TLS, { settings: { vnext: [vnextEntry("a.example.com"), vnextEntry("b.example.com")] } }), "unsupported_option", "vnext"],
    ["два пользователя", J.patched(J.OUT_VLESS_WS_TLS, { settings: { vnext: [{ address: "example.com", port: 443, users: [{ id: L.UUID }, { id: L.UUID.replace("1111", "2222") }] }] } }), "unsupported_option", "users"],
    ["шифр vmess zero", withVmess({ security: "zero" }), "unsupported_cipher", "scy"],
    ["шифр shadowsocks rc4-md5", withServer(J.OUT_SS_SIP002, { method: "rc4-md5" }), "unsupported_cipher", "method"],
    ["не UUID", withVless({ id: "not-a-uuid" }), "malformed", "uuid"],
    ["порт 0", J.patched(J.OUT_VLESS_WS_TLS, { settings: { vnext: [{ address: "example.com", port: 0, users: [{ id: L.UUID }] }] } }), "malformed", "port"],
    ["порт 70000", J.patched(J.OUT_VLESS_WS_TLS, { settings: { vnext: [{ address: "example.com", port: 70000, users: [{ id: L.UUID }] }] } }), "malformed", "port"],
    ["пустой адрес", withVless({}, ""), "malformed", "address"],
    ["пустой vnext", J.patched(J.OUT_VLESS_WS_TLS, { settings: { vnext: [] } }), "malformed", "vnext"],
    ["пустой список пользователей", J.patched(J.OUT_VLESS_WS_TLS, { settings: { vnext: [{ address: "example.com", port: 443, users: [] }] } }), "malformed", "users"],
    ["нет settings", { tag: "proxy", protocol: "vless" }, "malformed", "settings"],
    ["пустой список servers", J.patched(J.OUT_TROJAN_GRPC, { settings: { servers: [] } }), "malformed", "servers"],
    ["пустой пароль trojan", withServer(J.OUT_TROJAN_GRPC, { password: "" }), "malformed", "password"],
    ["пустой пароль shadowsocks", withServer(J.OUT_SS_SIP002, { password: "" }), "malformed", "password"],
    ["reality без публичного ключа", J.withStream(J.OUT_VLESS_REALITY, { realitySettings: { serverName: "www.example.com" } }), "malformed", "publicKey"],
    ["streamSettings не объект", J.patched(J.OUT_VLESS_WS_TLS, { streamSettings: "ws" }), "malformed", "streamSettings"],
  ];

  for (const [name, outbound, reason, detail] of CASES) {
    it(`${name}: ${reason} / ${detail}; соседний узел цел`, () => {
      const parsed = parse([J.config("плохой", outbound), J.config("хороший", J.OUT_TROJAN_GRPC)]);

      expect(parsed.skipped).toHaveLength(1);
      expect(parsed.skipped[0]).toMatchObject({ index: 0, reason, detail });
      expect(parsed.nodes.map((node) => node.name)).toEqual(["хороший"]);
    });
  }

  it("схема в пропуске — протокол выхода строчными", () => {
    const parsed = parse(J.config("x", J.withStream(J.OUT_VLESS_WS_TLS, { network: "kcp" })));
    expect(parsed.skipped).toEqual([{ index: 0, scheme: "vless", reason: "unsupported_transport", detail: "network" }]);
  });

  it("номер пропуска считает только узлы: служебные выходы в счёт не идут", () => {
    const parsed = parse([J.config("a", J.OUT_TROJAN_GRPC), J.config("b", J.withStream(J.OUT_VLESS_WS_TLS, { network: "kcp" })), J.config("c", { protocol: "socks" })]);
    expect(parsed.skipped.map((skip) => [skip.index, skip.scheme])).toEqual([
      [1, "vless"],
      [2, "socks"],
    ]);
  });

  it("в причинах пропуска нет UUID, пароля и адреса узла", () => {
    const parsed = parse(
      CASES.map(([name, outbound]) => J.config(name, outbound)),
    );
    const text = JSON.stringify(parsed.skipped);
    for (const secret of [L.UUID, "p@ss", "secret", "cGFzc3dvcmQ", "PUBLICKEY1", "example.com", "cdn.example.com"]) expect(text, secret).not.toContain(secret);
  });
});

describe("пределы", () => {
  const many = (count: number): J.Json[] => Array.from({ length: count }, (_, i) => J.config(`n${String(i)}`, J.patched(J.OUT_TROJAN_GRPC, { settings: { servers: [{ address: `h${String(i)}.example.com`, port: 443, password: `pw${String(i)}` }] } })));

  it("сверх maxLinks (1000) — truncated, разобрано ровно 1000", () => {
    const parsed = parse(many(1001));
    expect(parsed.truncated).toBe(true);
    expect(parsed.nodes).toHaveLength(1000);
  });

  it("свой потолок maxLinks; ровно по потолку — не усечено", () => {
    expect(parse(many(5), { maxLinks: 2 })).toMatchObject({ truncated: true, nodes: expect.any(Array) });
    expect(parse(many(5), { maxLinks: 2 }).nodes).toHaveLength(2);
    expect(parse(many(2), { maxLinks: 2 }).truncated).toBe(false);
  });

  it("служебные выходы потолок не расходуют", () => {
    const parsed = parse(many(3), { maxLinks: 3 });
    expect(parsed.truncated).toBe(false);
    expect(parsed.nodes).toHaveLength(3);
  });
});

describe("не тот формат", () => {
  it("битый JSON, не конфиг и чужой формат — unsupported_format", () => {
    const bodies = [
      '[{"remarks": "a", "outbounds": [',
      "{}",
      "[1, 2, 3]",
      '[{"remarks": "без выходов"}]',
      '{"outbounds": "vless"}',
      // sing-box: выходы есть, но не Xray (`type` вместо `protocol`)
      JSON.stringify({ outbounds: [{ type: "vless", server: "example.com", server_port: 443 }] }),
      "[".repeat(200_000),
    ];
    for (const body of bodies) expect(formatCode(body), body.slice(0, 40)).toBe("unsupported_format");
  });

  it("пустой список, конфиг без выходов и только служебные выходы — empty", () => {
    for (const body of ["[]", '{"outbounds": []}', '[{"remarks": "a", "outbounds": []}]', JSON.stringify([J.config("a", [])])]) {
      expect(formatCode(body), body).toBe("empty");
    }
  });

  it("ссылки по-прежнему разбираются, а JSON-подобный текст внутри base64 — нет", () => {
    const plain = [L.VLESS_WS_TLS, L.TROJAN_GRPC].join("\n");
    expect(parseSubscription(plain).format).toBe("plain");
    expect(parseSubscription(Buffer.from(plain).toString("base64")).format).toBe("base64");
    expect(() => parseSubscription(Buffer.from(JSON.stringify([J.config("a", J.OUT_TROJAN_GRPC)])).toString("base64"))).toThrow(SubscriptionFormatError);
  });
});
