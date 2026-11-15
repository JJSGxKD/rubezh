import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProxyNode } from "../src/node.js";
import { proxyNodeSchema } from "../src/node-schema.js";
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
  const config = buildXrayConfig([{ group: "main", node, slot: 0 }], OPTIONS) as { outbounds: Record<string, unknown>[] };
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

  it("плоская форма есть только у vless: у vmess без vnext — пропуск", () => {
    const outbound = J.patched(J.OUT_VMESS_WS_TLS, { settings: { address: "example.com", port: 443, id: L.UUID } });
    expect(parse(J.config("x", outbound)).skipped).toMatchObject([{ scheme: "vmess", reason: "malformed", detail: "vnext" }]);
  });

  it("адрес: ровно 253 знака и IPv6 в скобках проходят", () => {
    const longest = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    expect(longest).toHaveLength(253);
    const vless = (address: string): J.Json => J.patched(J.OUT_VLESS_WS_TLS, { settings: { vnext: [{ address, port: 443, users: [{ id: L.UUID }] }] } });

    expect(parse(J.config("x", vless(longest))).nodes[0]?.host).toBe(longest);
    expect(parse(J.config("x", vless("[2001:db8::10]"))).nodes[0]?.host).toBe("2001:db8::10");
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
    ["tcp с заголовком srtp", J.withStream(J.OUT_VLESS_REALITY, { tcpSettings: { header: { type: "srtp" } } }), "unsupported_option", "headerType"],
    ["allowInsecure", withTls({ allowInsecure: true }), "unsupported_option", "allowInsecure"],
    ["безопасность xtls", J.withStream(J.OUT_VLESS_WS_TLS, { security: "xtls" }), "unsupported_option", "security"],
    ["flow, убранный из Xray", withVless({ flow: "xtls-rprx-direct" }), "unsupported_option", "flow"],
    ["шифрование vless не по формату ядра", withVless({ encryption: "garbage" }), "malformed", "encryption"],
    ["ECH с пробелом", withTls({ echConfigList: "a b" }), "malformed", "ech"],
    ["ECH не строкой", withTls({ echConfigList: ["x"] }), "malformed", "ech"],
    ["echForceQuery не из списка", withTls({ echConfigList: "x", echForceQuery: "always" }), "malformed", "ech"],
    ["закреплённый сертификат не hex", withTls({ pinnedPeerCertSha256: "zz" }), "malformed", "pcs"],
    ["закреплённый сертификат списком", withTls({ pinnedPeerCertSha256: [L.PIN_HEX] }), "malformed", "pcs"],
    ["старое закрепление не списком строк", withTls({ pinnedPeerCertificateChainSha256: "abc" }), "malformed", "pcs"],
    ["старая проверка имён не списком строк", withTls({ verifyPeerCertInNames: [5] }), "malformed", "vcn"],
    ["проверка по имени с пробелом", withTls({ verifyPeerCertByName: "a b" }), "malformed", "vcn"],
    ["постквантовая проверка reality с пробелом", withReality({ mldsa65Verify: "a b" }), "malformed", "pqv"],
    ["extra не объектом", J.withStream(J.OUT_VLESS_XHTTP, { xhttpSettings: { path: "/x", extra: "str" } }), "malformed", "extra"],
    ["extra длиннее 4096 знаков", J.withStream(J.OUT_VLESS_XHTTP, { xhttpSettings: { path: "/x", extra: { v: "x".repeat(5000) } } }), "malformed", "extra"],
    ["downloadSettings с цепочкой", J.withStream(J.OUT_VLESS_XHTTP, { xhttpSettings: { path: "/x", extra: { downloadSettings: { sockopt: { dialerProxy: "fragment" } } } } }), "unsupported_option", "extra.downloadSettings"],
    ["dialerProxy на узел vless вместо freedom", J.withStream(J.OUT_VLESS_WS_TLS, { sockopt: { dialerProxy: "proxy" } }), "unsupported_option", "dialerProxy"],
    ["vmess alterId", withVmess({ alterId: 4 }), "unsupported_option", "aid"],
    ["цепочка через dialerProxy", J.withStream(J.OUT_VLESS_WS_TLS, { sockopt: { dialerProxy: "first-hop" } }), "unsupported_option", "dialerProxy"],
    ["цепочка через proxySettings", J.patched(J.OUT_VLESS_WS_TLS, { proxySettings: { tag: "first-hop" } }), "unsupported_option", "dialerProxy"],
    ["два сервера в vnext", J.patched(J.OUT_VLESS_WS_TLS, { settings: { vnext: [vnextEntry("a.example.com"), vnextEntry("b.example.com")] } }), "unsupported_option", "vnext"],
    ["два пользователя", J.patched(J.OUT_VLESS_WS_TLS, { settings: { vnext: [{ address: "example.com", port: 443, users: [{ id: L.UUID }, { id: L.UUID.replace("1111", "2222") }] }] } }), "unsupported_option", "users"],
    ["плоский vless: не UUID", J.patched(J.OUT_VLESS_REALITY_FLAT, { settings: { address: "example.com", port: 443, id: "not-a-uuid" } }), "malformed", "uuid"],
    ["плоский vless: нет id", J.patched(J.OUT_VLESS_REALITY_FLAT, { settings: { address: "example.com", port: 443 } }), "malformed", "uuid"],
    ["плоский vless: нет адреса", J.patched(J.OUT_VLESS_REALITY_FLAT, { settings: { port: 443, id: L.UUID } }), "malformed", "address"],
    ["плоский vless: порт 0", J.patched(J.OUT_VLESS_REALITY_FLAT, { settings: { address: "example.com", port: 0, id: L.UUID } }), "malformed", "port"],
    ["плоский vless: чужой flow", J.patched(J.OUT_VLESS_REALITY_FLAT, { settings: { address: "example.com", port: 443, id: L.UUID, flow: "xtls-rprx-direct" } }), "unsupported_option", "flow"],
    ["плоский vless: шифрование не по формату ядра", J.patched(J.OUT_VLESS_REALITY_FLAT, { settings: { address: "example.com", port: 443, id: L.UUID, encryption: "garbage" } }), "malformed", "encryption"],
    ["адрес с пробелом", withVless({}, "exa mple.com"), "malformed", "address"],
    ["адрес с пробелом по краям", withVless({}, " example.com "), "malformed", "address"],
    ["адрес с переводом строки", withVless({}, "example.com\n"), "malformed", "address"],
    ["адрес с управляющим знаком", withVless({}, "exa\u0007mple.com"), "malformed", "address"],
    ["адрес с «/»", withVless({}, "example.com/path"), "malformed", "address"],
    ["адрес с «\\»", withVless({}, "example.com\\path"), "malformed", "address"],
    ["адрес с «@»", withVless({}, "user@example.com"), "malformed", "address"],
    ["адрес длиннее 253 знаков", withVless({}, "a".repeat(254)), "malformed", "address"],
    ["адрес trojan с «/»", withServer(J.OUT_TROJAN_GRPC, { address: "example.com/x" }), "malformed", "address"],
    ["адрес плоского vless с «@»", J.patched(J.OUT_VLESS_REALITY_FLAT, { settings: { address: "a@b.example.com", port: 443, id: L.UUID } }), "malformed", "address"],
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

describe("мусор среди конфигов", () => {
  it("не-объекты в массиве, конфиг без выходов и выходы без protocol — в skipped как malformed, узлы целы", () => {
    const parsed = parse([
      J.config("хороший", J.OUT_TROJAN_GRPC),
      5,
      null,
      "text",
      [],
      { remarks: "без выходов" },
      { remarks: "x", outbounds: [{ type: "vless" }, 7, null, { protocol: 5 }] },
    ]);

    expect(parsed.nodes.map((node) => node.name)).toEqual(["хороший"]);
    expect(parsed.skipped).toEqual([
      { index: 1, scheme: "unknown", reason: "malformed", detail: "config" },
      { index: 2, scheme: "unknown", reason: "malformed", detail: "config" },
      { index: 3, scheme: "unknown", reason: "malformed", detail: "config" },
      { index: 4, scheme: "unknown", reason: "malformed", detail: "config" },
      { index: 5, scheme: "unknown", reason: "malformed", detail: "outbounds" },
      { index: 6, scheme: "unknown", reason: "malformed", detail: "protocol" },
      { index: 7, scheme: "unknown", reason: "malformed", detail: "protocol" },
      { index: 8, scheme: "unknown", reason: "malformed", detail: "protocol" },
      { index: 9, scheme: "unknown", reason: "malformed", detail: "protocol" },
    ]);
  });

  it("один конфиг-объект: выход без protocol среди выходов — пропуск, узел цел", () => {
    const parsed = parse({ outbounds: [J.OUT_TROJAN_GRPC, 5, { tag: "x" }] });
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.skipped).toEqual([
      { index: 1, scheme: "unknown", reason: "malformed", detail: "protocol" },
      { index: 2, scheme: "unknown", reason: "malformed", detail: "protocol" },
    ]);
  });

  it("мусор считается в maxLinks, а длинный хвост мусора не раздувает результат", () => {
    const parsed = parse([J.config("хороший", J.OUT_TROJAN_GRPC), ...Array.from({ length: 100_000 }, () => 0)]);
    expect(parsed.truncated).toBe(true);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.skipped).toHaveLength(999);

    const small = parse([J.config("хороший", J.OUT_TROJAN_GRPC), 1, 2, 3], { maxLinks: 2 });
    expect(small).toMatchObject({ truncated: true });
    expect(small.skipped).toHaveLength(1);
  });

  it("только служебные выходы и мусор: узлов нет, мусор в skipped, а не empty", () => {
    const parsed = parse([J.config("a", []), 5]);
    expect(parsed.nodes).toEqual([]);
    expect(parsed.skipped).toEqual([{ index: 0, scheme: "unknown", reason: "malformed", detail: "config" }]);
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

describe("маршрутизация конфигов", () => {
  const rules = (...items: Record<string, unknown>[]): Record<string, unknown> => ({ routing: { domainStrategy: "IPIfNonMatch", rules: items } });

  it("образец панели: у JSON-подписки есть сводка маршрутизации, узлы прежние", () => {
    const body = readFileSync(new URL("./fixtures/xray-json/remnawave-array.json", import.meta.url), "utf8");
    const parsed = parseSubscription(body);

    expect(parsed.routing).toEqual({ sources: ["json"], direct: 2, block: 0, hints: ["geoip:private"] });
    expect(parsed.nodes.map((item) => item.name)).toEqual(["🇩🇪 Germany", "[NL] Netherlands"]);
    expect(parsed.skipped).toEqual([]);
  });

  it("конфиг без правил в direct и block — routing: null; правила в proxy не считаются", () => {
    expect(parse(J.config("a", J.OUT_VLESS_WS_TLS, { routing: undefined })).routing).toBeNull();
    expect(parse(J.config("a", J.OUT_VLESS_WS_TLS, rules({ type: "field", outboundTag: "proxy", domain: ["geosite:google"] }))).routing).toBeNull();
  });

  it("правила собираются со всех конфигов подписки; повтор записи считается один раз", () => {
    const first = J.config("a", J.OUT_VLESS_WS_TLS, rules({ type: "field", outboundTag: "direct", domain: ["geosite:category-ru"] }, { type: "field", outboundTag: "block", ip: ["geoip:cn"] }));
    const second = J.config("b", J.OUT_VLESS_GRPC, rules({ type: "field", outboundTag: "direct", domain: ["geosite:category-ru", "geoip:ru"] }));

    expect(parse([first, second]).routing).toEqual({ sources: ["json"], direct: 2, block: 1, hints: ["geosite:category-ru", "geoip:ru"] });
  });

  it("мусор вместо routing не роняет разбор и узлы не трогает", () => {
    for (const routing of [5, "x", null, [], { rules: "x" }, { rules: [5, null] }]) {
      const parsed = parse(J.config("a", J.OUT_VLESS_WS_TLS, { routing }));
      expect(parsed.nodes, JSON.stringify(routing)).toHaveLength(1);
      expect(parsed.routing, JSON.stringify(routing)).toBeNull();
    }
  });

  it("правила из элемента, который не конфиг (нет outbounds), в сводку не попадают", () => {
    const notConfig = { routing: { rules: [{ outboundTag: "direct", domain: ["a.example.com"] }] } };
    const parsed = parse([5, null, notConfig, J.config("a", J.OUT_VLESS_WS_TLS)]);

    expect(parsed.nodes).toHaveLength(1);
    // только прежнее правило фикстуры `geoip:private`
    expect(parsed.routing).toEqual({ sources: ["json"], direct: 1, block: 0, hints: ["geoip:private"] });
  });
});

describe("способы подключения поставщиков (Р192, T-0387)", () => {
  const reality = (patch: Record<string, unknown>): J.Json =>
    J.withStream(J.OUT_VLESS_XHTTP, { realitySettings: { serverName: "www.example.com", publicKey: "PUBLICKEY2", shortId: "cd34", ...patch } });
  const xhttp = (settings: Record<string, unknown>): J.Json => J.withStream(J.OUT_VLESS_XHTTP, { xhttpSettings: { path: "/x", host: "h.example.com", mode: "auto", ...settings } });
  const only = (outbound: J.Json): ProxyNode => {
    const parsed = parse(J.config("x", outbound));
    expect(parsed.skipped).toEqual([]);
    return parsed.nodes[0] as ProxyNode;
  };

  /** Тот же узел, что у ссылки, — по узлу и по конфигу Xray. */
  const PAIRS: [name: string, link: string, outbound: J.Json][] = [
    ["xhttp с extra", L.VLESS_XHTTP_EXTRA, xhttp({ extra: L.XHTTP_EXTRA })],
    ["xhttp: поля extra лежат прямо в xhttpSettings", L.VLESS_XHTTP_EXTRA, xhttp(L.XHTTP_EXTRA)],
    [
      "ECH",
      L.VLESS_TLS_ECH,
      J.patched(J.OUT_VLESS_WS_TLS, { streamSettings: { network: "tcp", security: "tls", tlsSettings: { serverName: "example.com", echConfigList: L.ECH_CONFIG } } }),
    ],
    [
      "закреплённый сертификат и проверка по имени",
      L.VLESS_TLS_PINNED,
      J.patched(J.OUT_VLESS_WS_TLS, { streamSettings: { network: "tcp", security: "tls", tlsSettings: { serverName: "example.com", pinnedPeerCertSha256: L.PIN_HEX, verifyPeerCertByName: "example.com" } } }),
    ],
    ["постквантовая проверка reality", L.VLESS_REALITY_PQV, J.withStream(J.OUT_VLESS_REALITY, { realitySettings: { serverName: "www.example.com", fingerprint: "chrome", publicKey: "PUBLICKEY1", shortId: "ab12", mldsa65Verify: L.MLDSA65_VERIFY } })],
    [
      "flow с UDP 443",
      L.VLESS_VISION_UDP443,
      J.patched(J.OUT_VLESS_REALITY, {
        settings: { vnext: [{ address: "203.0.113.10", port: 443, users: [{ id: L.UUID, encryption: "none", flow: "xtls-rprx-vision-udp443" }] }] },
        streamSettings: { network: "tcp", security: "reality", realitySettings: { serverName: "www.example.com", fingerprint: "chrome", publicKey: "PUBLICKEY1", shortId: "ab12" } },
      }),
    ],
    [
      "шифрование VLESS",
      L.VLESS_ENCRYPTION,
      {
        tag: "proxy",
        protocol: "vless",
        settings: { vnext: [{ address: "203.0.113.13", port: 443, users: [{ id: L.UUID, encryption: L.VLESS_ENCRYPTION_VALUE }] }] },
        streamSettings: { network: "tcp", security: "none" },
      },
    ],
    [
      "RAW с HTTP-маскировкой",
      L.VMESS_RAW_HTTP,
      {
        tag: "proxy",
        protocol: "vmess",
        settings: { vnext: [{ address: "203.0.113.12", port: 80, users: [{ id: L.UUID, alterId: 0, security: "auto" }] }] },
        streamSettings: { network: "tcp", security: "none", tcpSettings: { header: L.RAW_HTTP_HEADER } },
      },
    ],
    [
      "RAW под новым именем rawSettings",
      L.VMESS_RAW_HTTP,
      {
        tag: "proxy",
        protocol: "vmess",
        settings: { vnext: [{ address: "203.0.113.12", port: 80, users: [{ id: L.UUID, alterId: 0, security: "auto" }] }] },
        streamSettings: { network: "raw", security: "none", rawSettings: { header: L.RAW_HTTP_HEADER } },
      },
    ],
  ];

  describe("узел из JSON равен узлу из ссылки", () => {
    for (const [name, link, outbound] of PAIRS) {
      it(name, () => {
        const fromLink = nodeOfLink(link);
        const fromJson = parse([J.config(fromLink.name, outbound)]);

        expect(fromJson.skipped).toEqual([]);
        expect(fromJson.nodes).toEqual([fromLink]);
        expect(outboundOf(fromJson.nodes[0] as ProxyNode)).toEqual(outboundOf(fromLink));
      });
    }
  });

  describe("extra у XHTTP", () => {
    it("прочие поля xhttpSettings и объект extra сливаются, extra важнее при совпадении ключа", () => {
      const node = only(xhttp({ xPaddingBytes: "1-2", noSSEHeader: true, extra: { xPaddingBytes: "100-1000", xmux: { maxConcurrency: "16-32" } } }));
      expect(node.transport).toEqual({
        network: "xhttp",
        path: "/x",
        host: "h.example.com",
        mode: "auto",
        extra: { xPaddingBytes: "100-1000", noSSEHeader: true, xmux: { maxConcurrency: "16-32" } },
      });
    });

    it("только path, host и mode — extra нет", () => {
      expect(only(J.OUT_VLESS_XHTTP).transport).not.toHaveProperty("extra");
    });

    it("downloadSettings с обычным sockopt проходит, с dialerProxy — пропуск extra.downloadSettings", () => {
      const download = { address: "203.0.113.12", port: 443, network: "xhttp", security: "reality", sockopt: { mark: 0 } };
      expect(only(xhttp({ extra: { downloadSettings: download } })).transport.extra).toEqual({ downloadSettings: download });

      const parsed = parse(J.config("x", xhttp({ extra: { downloadSettings: { ...download, sockopt: { dialerProxy: "fragment" } } } })));
      expect(parsed.skipped).toMatchObject([{ reason: "unsupported_option", detail: "extra.downloadSettings" }]);
      // то же, если поле лежит прямо в xhttpSettings
      expect(parse(J.config("x", xhttp({ downloadSettings: { sockopt: { dialerProxy: "fragment" } } }))).skipped).toMatchObject([{ detail: "extra.downloadSettings" }]);
    });

    it("у httpupgrade лишние поля по-прежнему отбрасываются", () => {
      const outbound = J.withStream(J.OUT_VLESS_HTTPUPGRADE, { httpupgradeSettings: { path: "/up", host: "up.example.com", extra: { a: 1 } } });
      expect(only(outbound).transport).toEqual({ network: "httpupgrade", path: "/up", host: "up.example.com" });
    });
  });

  describe("TLS и REALITY", () => {
    const tls = (patch: Record<string, unknown>): J.Json => J.withStream(J.OUT_VLESS_WS_TLS, { tlsSettings: { serverName: "cdn.example.com", ...patch } });

    it("echConfigList, echForceQuery, pinnedPeerCertSha256 и verifyPeerCertByName — в узел", () => {
      expect(only(tls({ echConfigList: L.ECH_CONFIG, echForceQuery: "half", pinnedPeerCertSha256: L.PIN_HEX, verifyPeerCertByName: "cdn.example.com" })).security).toMatchObject({
        kind: "tls",
        ech: L.ECH_CONFIG,
        echForceQuery: "half",
        pinnedPeerCertSha256: L.PIN_HEX,
        verifyPeerCertByName: "cdn.example.com",
      });
    });

    it("пустые значения — как не заданные", () => {
      const node = only(tls({ echConfigList: "", pinnedPeerCertSha256: "", verifyPeerCertByName: "" }));
      for (const field of ["ech", "pinnedPeerCertSha256", "verifyPeerCertByName", "legacyPinning"]) expect(node.security, field).not.toHaveProperty(field);
    });

    it("старые поля закрепления Xray принимает — они идут в legacyPinning как есть", () => {
      expect(only(J.OUT_VLESS_TLS_LEGACY_PINNING).security).toMatchObject({ kind: "tls", legacyPinning: J.LEGACY_PINNING });
      expect(only(tls({ verifyPeerCertInNames: ["a.example.com"] })).security).toMatchObject({ legacyPinning: { verifyPeerCertInNames: ["a.example.com"] } });
    });

    it("mldsa65Verify у reality — в узел", () => {
      expect(only(reality({ mldsa65Verify: L.MLDSA65_VERIFY })).security).toMatchObject({ kind: "reality", mldsa65Verify: L.MLDSA65_VERIFY });
    });

    it("allowInsecure по-прежнему пропуск, даже рядом с закреплением", () => {
      const parsed = parse(J.config("x", tls({ allowInsecure: true, pinnedPeerCertSha256: L.PIN_HEX })));
      expect(parsed.skipped).toMatchObject([{ reason: "unsupported_option", detail: "allowInsecure" }]);
    });
  });

  describe("RAW", () => {
    const withHeader = (header: unknown, key: "tcpSettings" | "rawSettings" = "tcpSettings"): J.Json =>
      J.patched(J.OUT_VMESS_WS_TLS, { streamSettings: { network: "tcp", security: "none", [key]: { header } } });

    it("header.type = http — rawHeader целиком", () => {
      const header = { type: "http", request: { version: "1.1", method: "GET", path: ["/a"], headers: { Host: ["h.example.com"], "User-Agent": ["x"] } } };
      expect(only(withHeader(header)).transport).toEqual({ network: "tcp", rawHeader: header });
      expect(only(withHeader(header, "rawSettings")).transport).toEqual({ network: "tcp", rawHeader: header });
    });

    it("none, пусто и без header — без rawHeader", () => {
      for (const header of [{ type: "none" }, { type: "" }, {}, undefined]) expect(only(withHeader(header)).transport, JSON.stringify(header)).toEqual({ network: "tcp" });
    });

    it("слишком большой заголовок — malformed / headerType", () => {
      const parsed = parse(J.config("x", withHeader({ type: "http", request: { path: ["/"], blob: "x".repeat(5000) } })));
      expect(parsed.skipped).toMatchObject([{ reason: "malformed", detail: "headerType" }]);
    });
  });

  describe("цепочка на freedom того же конфига", () => {
    const withChain = (node: J.Json, ...siblings: J.Json[]): ReturnType<typeof parse> => parse(J.config("chain", [node, ...siblings]));
    const proxySettings = (tag: string): J.Json => J.patched(J.OUT_VLESS_DIALER, { streamSettings: { network: "tcp", security: "tls", tlsSettings: { serverName: "example.com" } }, proxySettings: { tag } });

    it("sockopt.dialerProxy на freedom: настройки выхода — в узел, сам freedom не узел и не пропуск", () => {
      const parsed = withChain(J.OUT_VLESS_DIALER, J.OUT_FRAGMENT);
      expect(parsed.skipped).toEqual([]);
      expect(parsed.nodes).toHaveLength(1);
      expect(parsed.nodes[0]?.dialer).toEqual({ settings: J.FRAGMENT_SETTINGS });
    });

    it("порядок выходов не важен: freedom может стоять до узла", () => {
      const parsed = withChain(J.OUT_FRAGMENT, J.OUT_VLESS_DIALER);
      expect(parsed.nodes[0]?.dialer).toEqual({ settings: J.FRAGMENT_SETTINGS });
    });

    it("proxySettings.tag — то же, что dialerProxy", () => {
      expect(withChain(proxySettings("fragment"), J.OUT_FRAGMENT).nodes[0]?.dialer).toEqual({ settings: J.FRAGMENT_SETTINGS });
    });

    it("freedom без settings — пустые настройки; пустой dialerProxy — цепочки нет", () => {
      expect(withChain(J.OUT_VLESS_DIALER, { tag: "fragment", protocol: "freedom" }).nodes[0]?.dialer).toEqual({ settings: {} });
      const none = J.withStream(J.OUT_VLESS_DIALER, { sockopt: { dialerProxy: "" } });
      expect(withChain(none).nodes[0]).not.toHaveProperty("dialer");
    });

    it("узел с цепочкой и узел без неё — разные ключи", () => {
      const chained = withChain(J.OUT_VLESS_DIALER, J.OUT_FRAGMENT).nodes[0];
      const plain = withChain(J.withStream(J.OUT_VLESS_DIALER, { sockopt: {} })).nodes[0];
      expect(chained?.key).not.toBe(plain?.key);
    });

    it("настройки с redirect — пропуск dialerProxy.redirect: трафик ушёл бы на другой адрес", () => {
      const parsed = withChain(J.OUT_VLESS_DIALER, { tag: "fragment", protocol: "freedom", settings: { redirect: "203.0.113.50:443" } });
      expect(parsed.nodes).toEqual([]);
      expect(parsed.skipped).toMatchObject([{ reason: "unsupported_option", detail: "dialerProxy.redirect" }]);
      expect(JSON.stringify(parsed.skipped)).not.toContain("203.0.113.50");
    });

    it("соседа с таким тегом нет, он не freedom или он сам идёт через другой выход — пропуск dialerProxy", () => {
      const vless = J.patched(J.OUT_VLESS_WS_TLS, { tag: "fragment" });
      const chained = { tag: "fragment", protocol: "freedom", settings: {}, proxySettings: { tag: "other" } };
      const chainedSockopt = { tag: "fragment", protocol: "freedom", settings: {}, streamSettings: { sockopt: { dialerProxy: "other" } } };
      const cases: [name: string, siblings: J.Json[]][] = [
        ["соседа нет", []],
        ["сосед — узел vless", [vless]],
        ["сосед сам идёт через proxySettings", [chained]],
        ["сосед сам идёт через sockopt", [chainedSockopt]],
        ["сосед с другим тегом", [{ tag: "other", protocol: "freedom" }]],
      ];
      for (const [name, siblings] of cases) {
        const parsed = withChain(J.OUT_VLESS_DIALER, ...siblings);
        expect(parsed.skipped.filter((skip) => skip.detail === "dialerProxy"), name).toHaveLength(1);
        expect(parsed.nodes.every((node) => node.dialer === undefined), name).toBe(true);
      }
    });

    it("сосед из другого конфига массива не виден", () => {
      const parsed = parse([J.config("a", J.OUT_VLESS_DIALER), J.config("b", J.OUT_FRAGMENT)]);
      expect(parsed.skipped).toMatchObject([{ reason: "unsupported_option", detail: "dialerProxy" }]);
    });

    it("sockopt.dialerProxy и proxySettings на разные теги — пропуск dialerProxy", () => {
      const both = J.patched(J.OUT_VLESS_DIALER, { proxySettings: { tag: "other" } });
      expect(withChain(both, J.OUT_FRAGMENT, { tag: "other", protocol: "freedom" }).skipped).toMatchObject([{ detail: "dialerProxy" }]);
    });

    it("proxySettings без тега — пропуск proxySettings, как раньше", () => {
      const outbound = J.patched(J.OUT_VLESS_WS_TLS, { proxySettings: { transportLayer: true } });
      expect(withChain(outbound).skipped).toMatchObject([{ reason: "unsupported_option", detail: "proxySettings" }]);
    });

    it("слишком большие настройки freedom — malformed / dialerProxy", () => {
      const parsed = withChain(J.OUT_VLESS_DIALER, { tag: "fragment", protocol: "freedom", settings: { noises: [{ packet: "x".repeat(5000) }] } });
      expect(parsed.skipped).toMatchObject([{ reason: "malformed", detail: "dialerProxy" }]);
    });

    it("узел с цепочкой, собранный в конфиг, принимает схему узла", () => {
      const node = withChain(J.OUT_VLESS_DIALER, J.OUT_FRAGMENT).nodes[0] as ProxyNode;
      expect(proxyNodeSchema.parse(JSON.parse(JSON.stringify(node)))).toEqual(node);
    });
  });
});
