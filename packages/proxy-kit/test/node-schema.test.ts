import { describe, expect, it } from "vitest";
import { parseSubscription } from "../src/subscription.js";
import { parseShareLink } from "../src/share-link.js";
import type { ProxyNode } from "../src/node.js";
import { proxyNodeSchema } from "../src/node-schema.js";
import * as J from "./fixtures/xray-json.js";
import * as L from "./fixtures/links.js";

// Схема узла для чтения с диска: API хранит узлы подписки в файле-части тома
// (tasks/T-0384), а данные с диска — граница системы. Схема строго по типу
// `ProxyNode`: что парсер ссылок выдал, она принимает, всё остальное — нет.

const LINKS: [string, string][] = [
  ["vless reality", L.VLESS_REALITY],
  ["vless ws tls", L.VLESS_WS_TLS],
  ["vless grpc", L.VLESS_GRPC],
  ["vless xhttp reality", L.VLESS_XHTTP],
  ["vless httpupgrade", L.VLESS_HTTPUPGRADE],
  ["vless ipv6", L.VLESS_IPV6],
  ["vmess base64", L.VMESS_BASE64],
  ["vmess grpc", L.VMESS_GRPC_BASE64],
  ["vmess адресная форма", L.VMESS_ADDRESS],
  ["trojan grpc", L.TROJAN_GRPC],
  ["shadowsocks sip002", L.SS_SIP002],
  ["shadowsocks 2022", L.SS_2022],
  ["shadowsocks старая форма", L.SS_LEGACY],
];

function node(link: string): ProxyNode {
  const result = parseShareLink(link);
  if (!result.ok) throw new Error(`ссылка не разобралась: ${result.reason}`);
  return result.node;
}

describe("узел из разбора ссылки проходит схему без потерь", () => {
  for (const [name, link] of LINKS) {
    it(name, () => {
      const source = node(link);
      expect(proxyNodeSchema.parse(source)).toEqual(source);
    });
  }

  it("и после круга через JSON: файл на диске читается обратно тем же узлом", () => {
    for (const [, link] of LINKS) {
      const source = node(link);
      expect(proxyNodeSchema.parse(JSON.parse(JSON.stringify(source)))).toEqual(source);
    }
  });

  it("узлы JSON-подписки Xray тоже проходят", () => {
    const body = JSON.stringify([
      {
        remarks: "[DE] Берлин",
        outbounds: [
          {
            tag: "proxy",
            protocol: "vless",
            settings: { vnext: [{ address: "de.example.org", port: 443, users: [{ id: L.UUID, encryption: "none" }] }] },
            streamSettings: { network: "ws", security: "tls", tlsSettings: { serverName: "de.example.org" }, wsSettings: { path: "/ws" } },
          },
        ],
      },
    ]);
    const { nodes } = parseSubscription(body);
    expect(nodes).toHaveLength(1);
    for (const parsed of nodes) expect(proxyNodeSchema.parse(parsed)).toEqual(parsed);
  });
});

describe("отказ", () => {
  const base = node(L.VLESS_WS_TLS);
  const reject = (value: unknown): void => {
    expect(proxyNodeSchema.safeParse(value).success).toBe(false);
  };

  it("лишнее поле узла", () => {
    reject({ ...base, extra: 1 });
  });

  it("лишнее поле в транспорте и в безопасности", () => {
    reject({ ...base, transport: { ...base.transport, extra: 1 } });
    reject({ ...base, security: { ...base.security, extra: 1 } });
  });

  it("неизвестный network", () => {
    reject({ ...base, transport: { network: "kcp" } });
    reject({ ...base, transport: { network: "" } });
  });

  it("security.kind = x и неизвестный протокол", () => {
    reject({ ...base, security: { kind: "x" } });
    reject({ ...base, protocol: "hysteria2" });
  });

  it("не хватает обязательного поля", () => {
    for (const field of ["key", "protocol", "name", "host", "port", "secret", "flow", "cipher", "country", "transport", "security"]) {
      reject(Object.fromEntries(Object.entries(base).filter(([name]) => name !== field)));
    }
  });

  it("поле не того типа или вне границ", () => {
    reject({ ...base, port: "443" });
    reject({ ...base, port: 0 });
    reject({ ...base, port: 65_536 });
    reject({ ...base, port: 1.5 });
    reject({ ...base, secret: 42 });
    reject({ ...base, country: 7 });
    reject({ ...base, flow: undefined });
  });

  it("безопасность без обязательных полей своего вида", () => {
    reject({ ...base, security: { kind: "tls" } });
    reject({ ...base, security: { kind: "reality", serverName: "x" } });
    reject({ ...base, security: { kind: "tls", serverName: "x", alpn: "h2", fingerprint: null } });
  });

  it("не объект", () => {
    for (const value of [null, undefined, 42, "узел", [], [base]]) reject(value);
  });
});

describe("новые поля узла (Р192, T-0387)", () => {
  const chained = (): ProxyNode => {
    const body = JSON.stringify([J.config("x", [J.OUT_VLESS_DIALER, J.OUT_FRAGMENT])]);
    return parseSubscription(body).nodes[0] as ProxyNode;
  };
  const legacy = (): ProxyNode => parseSubscription(JSON.stringify([J.config("x", J.OUT_VLESS_TLS_LEGACY_PINNING)])).nodes[0] as ProxyNode;

  it("каждое новое поле, выданное разбором, проходит схему без потерь", () => {
    const nodes = [
      node(L.VLESS_XHTTP_EXTRA),
      node(L.VLESS_TLS_ECH),
      node(L.VLESS_TLS_PINNED),
      node(L.VLESS_REALITY_PQV),
      node(L.VLESS_ENCRYPTION),
      node(L.VLESS_VISION_UDP443),
      node(L.VMESS_RAW_HTTP),
      chained(),
      legacy(),
    ];
    for (const source of nodes) {
      expect(proxyNodeSchema.parse(source)).toEqual(source);
      expect(proxyNodeSchema.parse(JSON.parse(JSON.stringify(source)))).toEqual(source);
    }
    expect(chained().dialer).toEqual({ settings: J.FRAGMENT_SETTINGS });
    expect(legacy().security).toMatchObject({ legacyPinning: J.LEGACY_PINNING });
  });

  const reject = (value: unknown): void => {
    expect(proxyNodeSchema.safeParse(value).success).toBe(false);
  };
  const withTransport = (patch: Record<string, unknown>): unknown => ({ ...node(L.VLESS_XHTTP_EXTRA), transport: { ...node(L.VLESS_XHTTP_EXTRA).transport, ...patch } });
  const withTls = (patch: Record<string, unknown>): unknown => ({ ...node(L.VLESS_TLS_ECH), security: { ...node(L.VLESS_TLS_ECH).security, ...patch } });

  it("extra и rawHeader — только объект", () => {
    reject(withTransport({ extra: "строка" }));
    reject(withTransport({ extra: [1] }));
    reject(withTransport({ rawHeader: "http" }));
  });

  it("поля TLS и REALITY — строки; echForceQuery — из списка", () => {
    reject(withTls({ ech: 5 }));
    reject(withTls({ echForceQuery: "always" }));
    reject(withTls({ pinnedPeerCertSha256: [L.PIN_HEX] }));
    reject(withTls({ verifyPeerCertByName: 1 }));
    reject({ ...node(L.VLESS_REALITY_PQV), security: { ...node(L.VLESS_REALITY_PQV).security, mldsa65Verify: 1 } });
  });

  it("legacyPinning — только три известных поля и списки строк: в конфиг не попадёт чужое", () => {
    reject(withTls({ legacyPinning: { allowInsecure: true } }));
    reject(withTls({ legacyPinning: { pinnedPeerCertificateChainSha256: "abc" } }));
    reject(withTls({ legacyPinning: { verifyPeerCertInNames: [5] } }));
  });

  it("dialer — объект настроек; redirect в них недопустим", () => {
    const base = chained();
    reject({ ...base, dialer: "freedom" });
    reject({ ...base, dialer: { settings: "x" } });
    reject({ ...base, dialer: { settings: { redirect: "203.0.113.50:443" } } });
    reject({ ...base, dialer: { settings: {}, tag: "x" } });
  });

  it("слишком большой объект с диска — отказ, как и при разборе подписки", () => {
    reject(withTransport({ extra: { v: "x".repeat(5000) } }));
  });
});
