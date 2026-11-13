import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseShareLink } from "../src/share-link.js";
import type { ProxyNode } from "../src/node.js";
import { parseSubscription } from "../src/subscription.js";
import { trafficOfStats } from "../src/xray-stats.js";
import { assignSlots, buildXrayConfig, outboundTag, type PlacedNode } from "../src/xray-config.js";
import * as J from "./fixtures/xray-json.js";
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

  it("один и тот же узел одной подписки дважды (в разных слотах) — RangeError: тег выхода должен быть один", () => {
    const [first] = nodes;
    expect(() => buildXrayConfig([placed("a", first!, 0), placed("a", first!, 1)], OPTIONS)).toThrow(RangeError);
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

describe("счётчики трафика (docs/35-stage4-plan.md Р192, tasks/T-0386)", () => {
  type Stats = {
    stats?: unknown;
    api?: { tag: string; listen: string; services: string[] };
    policy?: { system: Record<string, unknown> };
    inbounds: { tag: string; port: number }[];
    routing: { rules: unknown[] };
  };
  const STATS = { port: 10799 };

  it("без stats конфиг прежний: блоков stats, api и policy нет", () => {
    const config = buildXrayConfig([placed("main", node(L.VLESS_REALITY), 0)], OPTIONS);
    expect(Object.keys(config)).toEqual(["log", "inbounds", "outbounds", "routing"]);
  });

  it("со stats — те же входы, выходы и правила, плюс три блока; совпадает с золотым файлом", () => {
    const source = node(L.VLESS_REALITY);
    const config = buildXrayConfig([placed("main", source, 0)], { ...OPTIONS, stats: STATS });
    expect(config).toEqual(golden("vless-reality-stats", source));
  });

  it("служба API одна — StatsService; слушает адрес входов и порт из stats; правил маршрутизации под API не добавляется", () => {
    const config = buildXrayConfig([placed("main", node(L.VLESS_REALITY), 0)], { ...OPTIONS, listen: "0.0.0.0", stats: STATS }) as Stats;
    expect(config.api).toEqual({ tag: "api", listen: "0.0.0.0:10799", services: ["StatsService"] });
    expect(config.stats).toEqual({});
    expect(config.policy).toEqual({ system: { statsOutboundUplink: true, statsOutboundDownlink: true } });
    // Счётчики входов и пользователей не включаются: нужны только выходы.
    expect(Object.keys(config.policy?.system ?? {}).sort()).toEqual(["statsOutboundDownlink", "statsOutboundUplink"]);
    expect(config.routing.rules).toHaveLength(1);
    expect(config.inbounds.map((inbound) => inbound.tag)).toEqual(["in-0"]);
  });

  it("пустой список узлов со stats — валидный конфиг: счётчики есть, входов нет", () => {
    const config = buildXrayConfig([], { ...OPTIONS, stats: STATS }) as Stats;
    expect(config.api?.services).toEqual(["StatsService"]);
    expect(config.inbounds).toEqual([]);
  });

  it("порт статистики внутри диапазона SOCKS-входов — RangeError: два слушателя на одном порту", () => {
    const first = placed("main", node(L.VLESS_REALITY), 0);
    expect(() => buildXrayConfig([first], { ...OPTIONS, stats: { port: 10800 } })).toThrow(RangeError);
    expect(() => buildXrayConfig([first], { ...OPTIONS, stats: { port: 10807 } })).toThrow(RangeError);
    expect(() => buildXrayConfig([first], { ...OPTIONS, stats: { port: 10808 } })).not.toThrow();
    expect(() => buildXrayConfig([first], { ...OPTIONS, stats: { port: 10799 } })).not.toThrow();
  });

  it("порт статистики не целое или вне 1…65535 — RangeError", () => {
    for (const port of [0, -1, 1.5, 65_536, Number.NaN]) {
      expect(() => buildXrayConfig([], { ...OPTIONS, stats: { port } }), String(port)).toThrow(RangeError);
    }
  });
});

describe("слоты", () => {
  const options =(patch: Partial<{ slotCount: number; reserved: ReadonlySet<number>; limit: number }> = {}) => ({ slotCount: 8, reserved: new Set<number>(), limit: 8, ...patch });

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

describe("способы подключения поставщиков (docs/35-stage4-plan.md Р192, tasks/T-0387)", () => {
  const LINK_CASES: [string, string][] = [
    ["vless-xhttp-extra-reality", L.VLESS_XHTTP_EXTRA],
    ["vless-tls-ech", L.VLESS_TLS_ECH],
    ["vless-tls-pinned", L.VLESS_TLS_PINNED],
    ["vless-reality-pqv", L.VLESS_REALITY_PQV],
    ["vless-encryption", L.VLESS_ENCRYPTION],
    ["vless-vision-udp443", L.VLESS_VISION_UDP443],
    ["vmess-raw-http-header", L.VMESS_RAW_HTTP],
  ];

  /** Узел из JSON-подписки: цепочка и старые поля закрепления ссылкой не передаются. */
  function jsonNode(outbounds: Record<string, unknown>[]): ProxyNode {
    const parsed = parseSubscription(JSON.stringify([J.config("x", outbounds)]));
    if (parsed.nodes.length !== 1) throw new Error(`узлов ${parsed.nodes.length}, пропусков ${JSON.stringify(parsed.skipped)}`);
    return parsed.nodes[0] as ProxyNode;
  }

  const JSON_CASES: [string, () => ProxyNode][] = [
    ["vless-dialer-fragment", () => jsonNode([J.OUT_VLESS_DIALER, J.OUT_FRAGMENT])],
    ["vless-tls-legacy-pinning", () => jsonNode([J.OUT_VLESS_TLS_LEGACY_PINNING])],
  ];

  describe("конфиг совпадает с золотым файлом", () => {
    for (const [name, link] of LINK_CASES) {
      it(name, () => {
        const source = node(link);
        expect(buildXrayConfig([placed("main", source, 0)], OPTIONS)).toEqual(golden(name, source));
      });
    }
    for (const [name, make] of JSON_CASES) {
      it(name, () => {
        const source = make();
        expect(buildXrayConfig([placed("main", source, 0)], OPTIONS)).toEqual(golden(name, source));
      });
    }
  });

  type Built = { outbounds: { tag: string; protocol: string; settings?: Record<string, unknown>; streamSettings?: Record<string, unknown> }[]; inbounds: unknown[]; routing: { rules: unknown[] } };

  describe("узел с цепочкой на freedom", () => {
    const chained = jsonNode([J.OUT_VLESS_DIALER, J.OUT_FRAGMENT]);

    it("два выхода — узел и <тег>-dial; sockopt.dialerProxy ведёт на второй; вход и правило — одни", () => {
      const config = buildXrayConfig([placed("main", chained, 0)], OPTIONS) as Built;
      const tag = outboundTag("main", chained.key);

      expect(config.outbounds.map((outbound) => outbound.tag)).toEqual(["block", tag, `${tag}-dial`]);
      expect(config.outbounds[1]?.streamSettings?.["sockopt"]).toEqual({ dialerProxy: `${tag}-dial` });
      expect(config.outbounds[2]).toEqual({ tag: `${tag}-dial`, protocol: "freedom", settings: J.FRAGMENT_SETTINGS });
      expect(config.inbounds).toHaveLength(1);
      expect(config.routing.rules).toEqual([{ type: "field", inboundTag: ["in-0"], outboundTag: tag }]);
    });

    it("служебный выход — сразу после выхода своего узла, у соседнего узла — свой", () => {
      const other = node(L.VLESS_WS_TLS);
      const config = buildXrayConfig([placed("main", other, 0), placed("main", chained, 1)], OPTIONS) as Built;
      expect(config.outbounds.map((outbound) => outbound.tag)).toEqual(["block", outboundTag("main", other.key), outboundTag("main", chained.key), `${outboundTag("main", chained.key)}-dial`]);
      expect(config.outbounds[1]?.streamSettings).not.toHaveProperty("sockopt");
    });

    it("один и тот же узел из двух подписок — две цепочки со своими тегами", () => {
      const config = buildXrayConfig([placed("a", chained, 0), placed("b", chained, 1)], OPTIONS) as Built;
      const tags = config.outbounds.map((outbound) => outbound.tag);
      expect(new Set(tags).size).toBe(tags.length);
      expect(tags).toContain(`${outboundTag("a", chained.key)}-dial`);
      expect(tags).toContain(`${outboundTag("b", chained.key)}-dial`);
    });

    it("тег с суффиксом -dial счётчик трафика узлом не считает", () => {
      const key = "0123456789abcdef";
      const stats = { stats: { port: 10799 } };
      const config = buildXrayConfig([placed("main", { ...chained, key }, 0)], { ...OPTIONS, ...stats }) as Built;
      const dial = config.outbounds.find((outbound) => outbound.tag.endsWith("-dial"));
      expect(dial?.tag).toBe(`out-main-${key}-dial`);
      expect(trafficOfStats([{ name: `outbound>>>${dial?.tag ?? ""}>>>traffic>>>uplink`, value: 100n }])).toEqual([]);
    });
  });

  describe("поля узла на своих местах", () => {
    const stream = (source: ProxyNode): Record<string, unknown> => {
      const config = buildXrayConfig([placed("main", source, 0)], OPTIONS) as Built;
      return config.outbounds[1]?.streamSettings ?? {};
    };

    it("extra — в xhttpSettings.extra, TLS-поля — в tlsSettings, постквантовая подпись — в realitySettings", () => {
      expect((stream(node(L.VLESS_XHTTP_EXTRA))["xhttpSettings"] as Record<string, unknown>)["extra"]).toEqual(L.XHTTP_EXTRA);
      expect(stream(node(L.VLESS_TLS_ECH))["tlsSettings"]).toMatchObject({ echConfigList: L.ECH_CONFIG });
      expect(stream(node(L.VLESS_TLS_PINNED))["tlsSettings"]).toMatchObject({ pinnedPeerCertSha256: L.PIN_HEX, verifyPeerCertByName: "example.com" });
      expect(stream(node(L.VLESS_REALITY_PQV))["realitySettings"]).toMatchObject({ mldsa65Verify: L.MLDSA65_VERIFY });
    });

    it("echForceQuery уходит в tlsSettings, когда задан", () => {
      const source = jsonNode([J.withStream(J.OUT_VLESS_WS_TLS, { tlsSettings: { serverName: "example.com", echConfigList: L.ECH_CONFIG, echForceQuery: "full" } })]);
      expect(stream(source)["tlsSettings"]).toMatchObject({ echConfigList: L.ECH_CONFIG, echForceQuery: "full" });
    });

    it("rawHeader — в tcpSettings.header", () => {
      expect(stream(node(L.VMESS_RAW_HTTP))["tcpSettings"]).toEqual({ header: L.RAW_HTTP_HEADER });
    });

    it("шифрование VLESS — в users[0].encryption; без него — none", () => {
      const users = (source: ProxyNode): Record<string, unknown>[] => {
        const config = buildXrayConfig([placed("main", source, 0)], OPTIONS) as Built;
        return ((config.outbounds[1]?.settings?.["vnext"] as { users: Record<string, unknown>[] }[])[0] as { users: Record<string, unknown>[] }).users;
      };
      expect(users(node(L.VLESS_ENCRYPTION))[0]).toMatchObject({ encryption: L.VLESS_ENCRYPTION_VALUE });
      expect(users(node(L.VLESS_WS_TLS))[0]).toMatchObject({ encryption: "none" });
    });

    it("узел без новых полей собирается как прежде: ни лишних ключей, ни служебного выхода", () => {
      const config = buildXrayConfig([placed("main", node(L.VLESS_WS_TLS), 0)], OPTIONS) as Built;
      expect(config.outbounds).toHaveLength(2);
      expect(config.outbounds[1]?.streamSettings).not.toHaveProperty("sockopt");
      expect(config.outbounds[1]?.streamSettings?.["tlsSettings"]).toEqual({ serverName: "cdn.example.com", alpn: ["h2", "http/1.1"], fingerprint: "firefox" });
    });
  });
});
