import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseShareLink } from "../src/share-link.js";
import type { ProxyNode } from "../src/node.js";
import { assignSlots, buildXrayConfig, outboundTag, type PlacedNode } from "../src/xray-config.js";
import * as L from "./fixtures/links.js";

// Конфиг спутника: Xray с локальным SOCKS-входом на каждый узел. Золотые
// файлы — выход для одного узла в слоте 0 подписки `main`; `{{KEY}}` в них
// заменяется ключом узла (он зависит от способа хэширования, а не от формата
// конфига). Тег выхода несёт ключ подписки: один узел может прийти из двух
// подписок (docs/35-stage4-plan.md Р192, tasks/T-0384).

const OPTIONS = { basePort: 10800, slotCount: 8, listen: "127.0.0.1" };

function node(link: string): ProxyNode {
  const result = parseShareLink(link);
  if (!result.ok) throw new Error(`ссылка не разобралась: ${result.reason}`);
  return result.node;
}

const placed = (group: string, source: ProxyNode, slot: number): PlacedNode => ({ group, node: source, slot });

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
      expect(buildXrayConfig([placed("main", source, 0)], OPTIONS)).toEqual(golden(name, source));
    });
  }
});

describe("входы и правила", () => {
  const nodes = CASES.map(([, link]) => node(link));
  type Built = {
    inbounds: { tag: string; port: number; listen: string }[];
    outbounds: { tag: string }[];
    routing: { rules: { inboundTag: string[]; outboundTag: string }[] };
  };

  it("порт входа — basePort + слот; на каждый вход правило на свой выход с ключом подписки", () => {
    const config = buildXrayConfig(
      nodes.map((source, index) => placed("main", source, index * 2)),
      { ...OPTIONS, slotCount: 16 },
    ) as Built;

    expect(config.inbounds.map((inbound) => [inbound.tag, inbound.port, inbound.listen])).toEqual(nodes.map((_, index) => [`in-${index * 2}`, 10800 + index * 2, "127.0.0.1"]));
    for (const [index, source] of nodes.entries()) {
      expect(config.routing.rules).toContainEqual({ type: "field", inboundTag: [`in-${index * 2}`], outboundTag: `out-main-${source.key}` });
      expect(config.outbounds.map((outbound) => outbound.tag)).toContain(`out-main-${source.key}`);
    }
    expect(config.routing.rules).toHaveLength(nodes.length);
  });

  it("тег выхода — out-<ключ подписки>-<ключ узла>", () => {
    expect(outboundTag("main", "0123456789abcdef")).toBe("out-main-0123456789abcdef");
    expect(outboundTag("a1b2c3", "ff")).toBe("out-a1b2c3-ff");
  });

  it("один узел из двух подписок — два входа, два выхода и два правила «вход → свой выход»", () => {
    const [shared] = nodes;
    const config = buildXrayConfig([placed("a", shared!, 0), placed("b", shared!, 1)], OPTIONS) as Built;

    expect(config.inbounds.map((inbound) => inbound.tag)).toEqual(["in-0", "in-1"]);
    expect(config.outbounds.map((outbound) => outbound.tag)).toEqual(["block", `out-a-${shared!.key}`, `out-b-${shared!.key}`]);
    expect(config.routing.rules).toEqual([
      { type: "field", inboundTag: ["in-0"], outboundTag: `out-a-${shared!.key}` },
      { type: "field", inboundTag: ["in-1"], outboundTag: `out-b-${shared!.key}` },
    ]);
  });

  it("узлы разных подписок идут в одном конфиге по возрастанию слота", () => {
    const [first, second, third] = nodes;
    const config = buildXrayConfig([placed("b", first!, 5), placed("a", second!, 1), placed("b", third!, 3)], OPTIONS) as Built;
    expect(config.inbounds.map((inbound) => inbound.tag)).toEqual(["in-1", "in-3", "in-5"]);
    expect(config.routing.rules.map((rule) => rule.outboundTag)).toEqual([`out-a-${second!.key}`, `out-b-${third!.key}`, `out-b-${first!.key}`]);
  });

  it("слоты в конфиге идут по возрастанию слота, а не по порядку списка узлов", () => {
    const [first, second] = nodes;
    const config = buildXrayConfig([placed("main", first!, 5), placed("main", second!, 1)], OPTIONS) as Built;
    expect(config.inbounds.map((inbound) => inbound.tag)).toEqual(["in-1", "in-5"]);
  });

  it("пустой список — валидный конфиг без входов, только выход block", () => {
    const config = buildXrayConfig([], OPTIONS) as { inbounds: unknown[]; outbounds: { tag: string; protocol: string }[]; routing: { rules: unknown[] } };
    expect(config.inbounds).toEqual([]);
    expect(config.outbounds).toEqual([{ tag: "block", protocol: "blackhole" }]);
    expect(config.routing.rules).toEqual([]);
  });

  it("блокирующий выход идёт первым: он выход по умолчанию для всего, что не попало в правила", () => {
    const config = buildXrayConfig([placed("main", nodes[0]!, 0)], OPTIONS) as Built;
    expect(config.outbounds[0]?.tag).toBe("block");
  });

  it("слот вне диапазона slotCount — RangeError, а не молчаливый порт за пределами", () => {
    const [first] = nodes;
    expect(() => buildXrayConfig([placed("main", first!, 8)], OPTIONS)).toThrow(RangeError);
    expect(() => buildXrayConfig([placed("main", first!, -1)], OPTIONS)).toThrow(RangeError);
    expect(() => buildXrayConfig([placed("main", first!, 1.5)], OPTIONS)).toThrow(RangeError);
  });

  it("повтор слота у двух узлов, даже из разных подписок, — RangeError: два входа на одном порту", () => {
    const [first, second] = nodes;
    expect(() => buildXrayConfig([placed("a", first!, 2), placed("b", second!, 2)], OPTIONS)).toThrow(RangeError);
    expect(() => buildXrayConfig([placed("a", first!, 2), placed("a", second!, 2)], OPTIONS)).toThrow(RangeError);
  });

  it("ключ подписки не по формату ^[a-z0-9]{1,16}$ — RangeError", () => {
    const [first] = nodes;
    for (const group of ["Main", "", "a-b", "a b", "a".repeat(17), "ключ"]) {
      expect(() => buildXrayConfig([placed(group, first!, 0)], OPTIONS), group).toThrow(RangeError);
    }
    expect(() => buildXrayConfig([placed("a".repeat(16), first!, 0)], OPTIONS)).not.toThrow();
  });

  it("конфиг сериализуется в JSON без потерь", () => {
    const config = buildXrayConfig(
      nodes.map((source, index) => placed("main", source, index)),
      OPTIONS,
    );
    expect(JSON.parse(JSON.stringify(config))).toEqual(config);
  });
});

describe("слоты", () => {
  const options = (patch: Partial<{ slotCount: number; reserved: ReadonlySet<number>; limit: number }> = {}) => ({ slotCount: 8, reserved: new Set<number>(), limit: 8, ...patch });

  it("прежние слоты сохраняются при смене порядка", () => {
    const previous = new Map([["a", 0], ["b", 1], ["c", 2]]);
    const { slots, overflow } = assignSlots(["c", "a", "b"], previous, options());
    expect(Object.fromEntries(slots)).toEqual({ a: 0, b: 1, c: 2 });
    expect(overflow).toEqual([]);
  });

  it("ушедший узел освобождает слот, новый берёт наименьший свободный", () => {
    const previous = new Map([["a", 0], ["b", 1], ["c", 2]]);
    const { slots } = assignSlots(["a", "c", "d"], previous, options());
    expect(Object.fromEntries(slots)).toEqual({ a: 0, c: 2, d: 1 });
  });

  it("новые узлы берут слоты по порядку списка", () => {
    const { slots } = assignSlots(["x", "y", "z"], new Map(), options());
    expect(Object.fromEntries(slots)).toEqual({ x: 0, y: 1, z: 2 });
  });

  it("слотов меньше, чем узлов, — лишние в overflow, без слота", () => {
    const { slots, overflow } = assignSlots(["a", "b", "c", "d"], new Map([["b", 1]]), options({ slotCount: 3, limit: 3 }));
    expect(Object.fromEntries(slots)).toEqual({ b: 1, a: 0, c: 2 });
    expect(overflow).toEqual(["d"]);
  });

  it("прежний слот за пределами slotCount не сохраняется", () => {
    const { slots } = assignSlots(["a"], new Map([["a", 9]]), options({ slotCount: 4, limit: 4 }));
    expect(slots.get("a")).toBe(0);
  });

  it("два узла с одним прежним слотом не получают один слот на двоих", () => {
    const { slots } = assignSlots(["a", "b"], new Map([["a", 1], ["b", 1]]), options({ slotCount: 4, limit: 4 }));
    expect(new Set(slots.values()).size).toBe(2);
    expect(slots.get("a")).toBe(1);
  });

  it("повтор ключа в списке учитывается один раз", () => {
    const { slots, overflow } = assignSlots(["a", "a", "b"], new Map(), options());
    expect(Object.fromEntries(slots)).toEqual({ a: 0, b: 1 });
    expect(overflow).toEqual([]);
  });

  it("прежний слот, занятый другой подпиской (reserved), не берётся: узел получает другой", () => {
    const { slots } = assignSlots(["a", "b"], new Map([["a", 1], ["b", 2]]), options({ reserved: new Set([1]) }));
    expect(slots.get("a")).toBe(0);
    expect(slots.get("b")).toBe(2);
  });

  it("новый узел берёт наименьший свободный слот вне reserved", () => {
    const { slots } = assignSlots(["x", "y"], new Map(), options({ reserved: new Set([0, 1, 3]) }));
    expect(Object.fromEntries(slots)).toEqual({ x: 2, y: 4 });
  });

  it("limit = 2 при трёх узлах: два слота и один в overflow, даже если свободных слотов больше", () => {
    const { slots, overflow } = assignSlots(["a", "b", "c"], new Map(), options({ limit: 2 }));
    expect(Object.fromEntries(slots)).toEqual({ a: 0, b: 1 });
    expect(overflow).toEqual(["c"]);
  });

  it("прежние слоты в пределах доли сохраняются, сверх доли — в overflow", () => {
    const previous = new Map([["a", 5], ["b", 6], ["c", 7]]);
    const { slots, overflow } = assignSlots(["a", "b", "c", "d"], previous, options({ limit: 3 }));
    expect(Object.fromEntries(slots)).toEqual({ a: 5, b: 6, c: 7 });
    expect(overflow).toEqual(["d"]);
  });

  it("прежних слотов больше доли: лишние теряют слот, остаются первые по списку", () => {
    const previous = new Map([["a", 0], ["b", 1], ["c", 2]]);
    const { slots, overflow } = assignSlots(["a", "b", "c"], previous, options({ limit: 2 }));
    expect(Object.fromEntries(slots)).toEqual({ a: 0, b: 1 });
    expect(overflow).toEqual(["c"]);
  });

  it("limit нулевой — все в overflow", () => {
    const { slots, overflow } = assignSlots(["a", "b"], new Map(), options({ limit: 0 }));
    expect(slots.size).toBe(0);
    expect(overflow).toEqual(["a", "b"]);
  });

  it("свободных вне reserved нет — overflow, а не слот из чужих", () => {
    const { slots, overflow } = assignSlots(["a", "b"], new Map(), options({ slotCount: 3, limit: 3, reserved: new Set([0, 1]) }));
    expect(Object.fromEntries(slots)).toEqual({ a: 2 });
    expect(overflow).toEqual(["b"]);
  });
});
