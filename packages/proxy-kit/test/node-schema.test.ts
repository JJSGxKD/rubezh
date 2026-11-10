import { describe, expect, it } from "vitest";
import { parseSubscription } from "../src/subscription.js";
import { parseShareLink } from "../src/share-link.js";
import type { ProxyNode } from "../src/node.js";
import { proxyNodeSchema } from "../src/node-schema.js";
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
