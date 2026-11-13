import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseShareLink } from "../src/share-link.js";
import { parseSubscription } from "../src/subscription.js";
import * as L from "./fixtures/links.js";

// Ключ узла — его слот и здоровье: после выкатки нового разбора узлы, у которых
// нет новых параметров, обязаны сохранить прежний ключ (docs/35-stage4-plan.md Р192,
// tasks/T-0387). Числа записаны до правки `finishNode` и менять их нельзя.

const LINK_KEYS: [name: string, link: string, key: string][] = [
  ["VLESS_REALITY", L.VLESS_REALITY, "74a06ad963d0159f"],
  ["VLESS_WS_TLS", L.VLESS_WS_TLS, "db09e8b1aada7dc6"],
  ["VLESS_GRPC", L.VLESS_GRPC, "9d26730f1c9ba23c"],
  ["VLESS_XHTTP", L.VLESS_XHTTP, "b2e0953f0a1256b6"],
  ["VLESS_HTTPUPGRADE", L.VLESS_HTTPUPGRADE, "515e7558753d1e72"],
  ["VLESS_IPV6", L.VLESS_IPV6, "79927849ef24e08b"],
  ["VMESS_BASE64", L.VMESS_BASE64, "60124c9aaf299100"],
  ["VMESS_GRPC_BASE64", L.VMESS_GRPC_BASE64, "6043aad62e11e51c"],
  ["VMESS_ADDRESS", L.VMESS_ADDRESS, "3b243e3f094dfad9"],
  ["TROJAN_GRPC", L.TROJAN_GRPC, "cdbaaa22851deaaa"],
  ["SS_SIP002", L.SS_SIP002, "ea8ee4332e1d905d"],
  ["SS_2022", L.SS_2022, "f1c8f07913c603c0"],
  ["SS_LEGACY", L.SS_LEGACY, "103ff8e775047255"],
];

describe("ключи узлов до задачи не меняются", () => {
  for (const [name, link, key] of LINK_KEYS) {
    it(name, () => {
      const result = parseShareLink(link);
      expect(result.ok && result.node.key).toBe(key);
    });
  }

  it("узлы образца JSON-подписки панели", () => {
    const body = readFileSync(new URL("./fixtures/xray-json/remnawave-array.json", import.meta.url), "utf8");
    expect(parseSubscription(body).nodes.map((node) => [node.name, node.key])).toEqual([
      ["🇩🇪 Germany", "74a06ad963d0159f"],
      ["[NL] Netherlands", "47c55461f3568fe5"],
    ]);
  });
});

describe("новые параметры меняют ключ только когда заданы", () => {
  const keyOf = (link: string): string => {
    const result = parseShareLink(link);
    if (!result.ok) throw new Error(`ссылка не разобралась: ${result.reason} ${result.detail}`);
    return result.node.key;
  };

  it("узел с новым параметром — не тот же слот, что узел без него", () => {
    const plain = `vless://${L.UUID}@example.com:443?type=tcp&security=tls&sni=example.com`;
    expect(keyOf(`${plain}&ech=ECHCONFIG1`)).not.toBe(keyOf(plain));
    expect(keyOf(`${plain}&pcs=${L.PIN_HEX}`)).not.toBe(keyOf(plain));
    expect(keyOf(`${plain}&vcn=example.com`)).not.toBe(keyOf(plain));
  });

  it("порядок ключей в `extra` на ключ не влияет: JSON каноничен", () => {
    const base = `vless://${L.UUID}@203.0.113.11:443?type=xhttp&security=reality&sni=www.example.com&pbk=PUBLICKEY2&sid=cd34`;
    const a = encodeURIComponent(JSON.stringify({ a: 1, b: { x: 1, y: 2 } }));
    const b = encodeURIComponent(JSON.stringify({ b: { y: 2, x: 1 }, a: 1 }));
    expect(keyOf(`${base}&extra=${a}`)).toBe(keyOf(`${base}&extra=${b}`));
    expect(keyOf(`${base}&extra=${a}`)).not.toBe(keyOf(base));
  });

  it("разные значения одного параметра — разные узлы", () => {
    const base = `vless://${L.UUID}@203.0.113.13:443?type=tcp&security=none`;
    expect(keyOf(`${base}&encryption=mlkem768x25519plus.native.0rtt.AAA`)).not.toBe(keyOf(`${base}&encryption=mlkem768x25519plus.native.0rtt.BBB`));
  });
});
