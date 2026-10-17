import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseShareLink } from "../src/share-link.js";
import type { ProxyNode } from "../src/node.js";
import { assignSlots, buildXrayConfig } from "../src/xray-config.js";
import * as L from "./fixtures/links.js";

// Конфиг спутника: Xray с локальным SOCKS-входом на каждый узел. Золотые
// файлы — выход для одного узла в слоте 0; `{{KEY}}` в них заменяется ключом
// узла (он зависит от способа хэширования, а не от формата конфига).

const OPTIONS = { basePort: 10800, slotCount: 8, listen: "127.0.0.1" };

function node(link: string): ProxyNode {
  const result = parseShareLink(link);
  if (!result.ok) throw new Error(`ссылка не разобралась: ${result.reason}`);
  return result.node;
}

function golden(name: string, source: ProxyNode): unknown {
  const text = readFileSync(new URL(`./fixtures/xray/${name}.json`, import.meta.url), "utf8").replaceAll("{{KEY}}", source.key);
  return JSON.parse(text);
}

const CASES: [string, string][] = [
  ["vless-reality-tcp", L.VLESS_REALITY],
  ["vless-ws-tls", L.VLESS_WS_TLS],
  ["vmess-ws-tls", L.VMESS_BASE64],
  ["trojan-grpc-tls", L.TROJAN_GRPC],
  ["shadowsocks-2022", L.SS_2022],
  ["vless-xhttp-reality", L.VLESS_XHTTP],
];

describe("конфиг одного узла совпадает с золотым файлом", () => {
  for (const [name, link] of CASES) {
    it(name, () => {
      const source = node(link);
      expect(buildXrayConfig([source], new Map([[source.key, 0]]), OPTIONS)).toEqual(golden(name, source));
    });
  }
});

describe("входы и правила", () => {
  const nodes = CASES.map(([, link]) => node(link));

  it("порт входа — basePort + слот; на каждый вход правило на свой выход", () => {
    const slots = new Map(nodes.map((source, index) => [source.key, index * 2] as const));
    const config = buildXrayConfig(nodes, slots, OPTIONS) as {
      inbounds: { tag: string; port: number; listen: string }[];
      outbounds: { tag: string }[];
      routing: { rules: { inboundTag: string[]; outboundTag: string }[] };
    };

    expect(config.inbounds.map((inbound) => [inbound.tag, inbound.port, inbound.listen])).toEqual(nodes.map((_, index) => [`in-${index * 2}`, 10800 + index * 2, "127.0.0.1"]));
    for (const [index, source] of nodes.entries()) {
      expect(config.routing.rules).toContainEqual({ type: "field", inboundTag: [`in-${index * 2}`], outboundTag: `out-${source.key}` });
      expect(config.outbounds.map((outbound) => outbound.tag)).toContain(`out-${source.key}`);
    }
    expect(config.routing.rules).toHaveLength(nodes.length);
  });

  it("узел без слота в конфиг не входит", () => {
    const [first, second] = nodes;
    const config = buildXrayConfig([first!, second!], new Map([[first!.key, 3]]), OPTIONS) as { inbounds: { tag: string }[]; outbounds: { tag: string }[] };
    expect(config.inbounds.map((inbound) => inbound.tag)).toEqual(["in-3"]);
    expect(config.outbounds.map((outbound) => outbound.tag)).not.toContain(`out-${second!.key}`);
  });

  it("слоты в конфиге идут по возрастанию слота, а не по порядку списка узлов", () => {
    const [first, second] = nodes;
    const config = buildXrayConfig([first!, second!], new Map([[first!.key, 5], [second!.key, 1]]), OPTIONS) as { inbounds: { tag: string }[] };
    expect(config.inbounds.map((inbound) => inbound.tag)).toEqual(["in-1", "in-5"]);
  });

  it("пустой список — валидный конфиг без входов, только выход block", () => {
    const config = buildXrayConfig([], new Map(), OPTIONS) as { inbounds: unknown[]; outbounds: { tag: string; protocol: string }[]; routing: { rules: unknown[] } };
    expect(config.inbounds).toEqual([]);
    expect(config.outbounds).toEqual([{ tag: "block", protocol: "blackhole" }]);
    expect(config.routing.rules).toEqual([]);
  });

  it("блокирующий выход идёт первым: он выход по умолчанию для всего, что не попало в правила", () => {
    const config = buildXrayConfig([nodes[0]!], new Map([[nodes[0]!.key, 0]]), OPTIONS) as { outbounds: { tag: string }[] };
    expect(config.outbounds[0]?.tag).toBe("block");
  });

  it("слот вне диапазона slotCount — ошибка, а не молчаливый порт за пределами", () => {
    const [first] = nodes;
    expect(() => buildXrayConfig([first!], new Map([[first!.key, 8]]), OPTIONS)).toThrow();
    expect(() => buildXrayConfig([first!], new Map([[first!.key, -1]]), OPTIONS)).toThrow();
  });

  it("конфиг сериализуется в JSON без потерь", () => {
    const config = buildXrayConfig(nodes, new Map(nodes.map((source, index) => [source.key, index] as const)), OPTIONS);
    expect(JSON.parse(JSON.stringify(config))).toEqual(config);
  });
});

describe("слоты", () => {
  it("прежние слоты сохраняются при смене порядка", () => {
    const previous = new Map([["a", 0], ["b", 1], ["c", 2]]);
    const { slots, overflow } = assignSlots(["c", "a", "b"], previous, 8);
    expect(Object.fromEntries(slots)).toEqual({ a: 0, b: 1, c: 2 });
    expect(overflow).toEqual([]);
  });

  it("ушедший узел освобождает слот, новый берёт наименьший свободный", () => {
    const previous = new Map([["a", 0], ["b", 1], ["c", 2]]);
    const { slots } = assignSlots(["a", "c", "d"], previous, 8);
    expect(Object.fromEntries(slots)).toEqual({ a: 0, c: 2, d: 1 });
  });

  it("новые узлы берут слоты по порядку списка", () => {
    const { slots } = assignSlots(["x", "y", "z"], new Map(), 8);
    expect(Object.fromEntries(slots)).toEqual({ x: 0, y: 1, z: 2 });
  });

  it("слотов меньше, чем узлов, — лишние в overflow, без слота", () => {
    const { slots, overflow } = assignSlots(["a", "b", "c", "d"], new Map([["b", 1]]), 3);
    expect(Object.fromEntries(slots)).toEqual({ b: 1, a: 0, c: 2 });
    expect(overflow).toEqual(["d"]);
  });

  it("прежний слот за пределами slotCount не сохраняется", () => {
    const { slots } = assignSlots(["a"], new Map([["a", 9]]), 4);
    expect(slots.get("a")).toBe(0);
  });

  it("два узла с одним прежним слотом не получают один слот на двоих", () => {
    const { slots } = assignSlots(["a", "b"], new Map([["a", 1], ["b", 1]]), 4);
    expect(new Set(slots.values()).size).toBe(2);
    expect(slots.get("a")).toBe(1);
  });

  it("повтор ключа в списке учитывается один раз", () => {
    const { slots, overflow } = assignSlots(["a", "a", "b"], new Map(), 8);
    expect(Object.fromEntries(slots)).toEqual({ a: 0, b: 1 });
    expect(overflow).toEqual([]);
  });
});
