import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hasOwnRouting, mergeRouting, parseRoutingHeader, routingOfConfigs, type RoutingSummary } from "../src/routing.js";

// Маршрутизация подписки — сведения для панели, а не часть перебора: JSON-конфиги
// Xray (правила в `freedom` и `blackhole`) и заголовок `routing` панелей Happ.
// Записи считаются после схлопывания повторов; в подсказки идут только
// `geosite:` и `geoip:`; мусор не роняет разбор.

const UNPARSED: RoutingSummary = { sources: ["header"], direct: null, block: null, hints: [] };

type Json = Record<string, unknown>;

/** Конфиг клиента: выходы — прокси, `direct` (freedom) и `block` (blackhole); правила — как переданы. */
const config = (rules: unknown, outbounds: Json[] = []): Json => ({
  remarks: "тест",
  outbounds: [{ tag: "proxy", protocol: "vless" }, { tag: "direct", protocol: "freedom" }, { tag: "block", protocol: "blackhole" }, ...outbounds],
  routing: { domainStrategy: "IPIfNonMatch", rules },
});

const toDirect = (entry: Json): Json => ({ type: "field", outboundTag: "direct", ...entry });
const toBlock = (entry: Json): Json => ({ type: "field", outboundTag: "block", ...entry });
const toProxy = (entry: Json): Json => ({ type: "field", outboundTag: "proxy", ...entry });

const fixtureConfigs = (): unknown[] => JSON.parse(readFileSync(new URL("./fixtures/xray-json/remnawave-array.json", import.meta.url), "utf8")) as unknown[];

/** Заголовок Happ: ссылка с base64 от JSON; `url` — вариант без `=` и с `-`/`_` вместо `+`/`/`. */
function happ(payload: unknown, options: { url?: boolean; verb?: "add" | "onadd" } = {}): string {
  const base = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const body = options.url === true ? base.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : base;
  return `happ://routing/${options.verb ?? "onadd"}/${body}`;
}

describe("routingOfConfigs: JSON-конфиги подписки", () => {
  it("образец панели: правила в direct считаются, правило с protocol — одной записью", () => {
    expect(routingOfConfigs(fixtureConfigs())).toEqual({ sources: ["json"], direct: 2, block: 0, hints: ["geoip:private"] });
  });

  it("повтор правила во втором конфиге счёт не удваивает", () => {
    const configs = fixtureConfigs();
    const [first] = configs;
    expect(routingOfConfigs([first, first, ...configs])).toEqual({ sources: ["json"], direct: 2, block: 0, hints: ["geoip:private"] });
  });

  it("тот же список, но выход назван иначе: тег в ключ записи не входит", () => {
    const a = config([toDirect({ domain: ["geosite:category-ru"] })]);
    const b = {
      outbounds: [{ tag: "freedom-out", protocol: "freedom" }],
      routing: { rules: [{ type: "field", outboundTag: "freedom-out", domain: ["geosite:category-ru"] }] },
    };
    expect(routingOfConfigs([a, b])?.direct).toBe(1);
  });

  it("правило в proxy и правило с balancerTag не считаются; только такие — null", () => {
    const rules = [toProxy({ domain: ["geosite:google"] }), { type: "field", balancerTag: "lb", domain: ["geosite:netflix"] }, toDirect({ domain: ["geosite:category-ru"] })];
    expect(routingOfConfigs([config(rules)])).toEqual({ sources: ["json"], direct: 1, block: 0, hints: ["geosite:category-ru"] });
    expect(routingOfConfigs([config([toProxy({ domain: ["geosite:google"] }), { type: "field", balancerTag: "lb", ip: ["geoip:us"] }])])).toBeNull();
  });

  it("выход с тегом, которого нет среди outbounds, правило не считает", () => {
    expect(routingOfConfigs([config([{ type: "field", outboundTag: "unknown-tag", domain: ["geosite:x"] }])])).toBeNull();
  });

  it("blackhole считается как блокировка и в подсказки не идёт", () => {
    const rules = [toBlock({ domain: ["geosite:category-ads-all"] }), toBlock({ ip: ["geoip:cn", "1.2.3.4"] })];
    expect(routingOfConfigs([config(rules)])).toEqual({ sources: ["json"], direct: 0, block: 3, hints: [] });
  });

  it("мимо туннеля и блокировка считаются раздельно; одна запись в обоих списках — по разу в каждом", () => {
    const rules = [toDirect({ domain: ["domain:example.com"] }), toBlock({ domain: ["domain:example.com", "domain:ads.example.org"] })];
    expect(routingOfConfigs([config(rules)])).toMatchObject({ direct: 1, block: 2 });
  });

  it("записи правила — элементы domain и ip; правило без них — одна запись по самому правилу", () => {
    const rules = [
      toDirect({ domain: ["a.example.com", "b.example.com"], ip: ["10.0.0.0/8"] }),
      toDirect({ port: "53", network: "udp" }),
      // порядок ключей и тег выхода записи не различают
      { network: "udp", outboundTag: "freedom-out", type: "field", port: "53" },
      toDirect({ port: "443" }),
    ];
    expect(routingOfConfigs([config(rules, [{ tag: "freedom-out", protocol: "freedom" }])])?.direct).toBe(5);
  });

  it("повтор записи в другом регистре и с пробелами схлопывается", () => {
    const rules = [toDirect({ domain: ["Domain:Example.com", " domain:example.com "] })];
    expect(routingOfConfigs([config(rules)])?.direct).toBe(1);
  });

  it("подсказки: строчные, без повторов, не больше 8, по первому появлению", () => {
    const names = Array.from({ length: 10 }, (_, index) => `geosite:list-${String(index)}`);
    const rules = [toDirect({ domain: ["GEOSITE:Category-RU", ...names, "geosite:category-ru"] })];
    const summary = routingOfConfigs([config(rules)]);

    expect(summary?.direct).toBe(11);
    expect(summary?.hints).toEqual(["geosite:category-ru", ...names.slice(0, 7)]);
    expect(summary?.hints).toHaveLength(8);
  });

  it("domain:, сырой домен и IP в подсказки не идут, но считаются; негодное имя списка — тоже", () => {
    const rules = [toDirect({ domain: ["domain:example.com", "example.org", "geosite:with space", `geosite:${"a".repeat(57)}`, "geosite:ok-1.2_x@cn!"], ip: ["203.0.113.5", "geoip:ru"] })];
    const summary = routingOfConfigs([config(rules)]);

    expect(summary?.direct).toBe(7);
    expect(summary?.hints).toEqual(["geosite:ok-1.2_x@cn!", "geoip:ru"]);
  });

  it("мусор вместо routing не роняет разбор", () => {
    const garbage: unknown[] = [
      { outbounds: [{ tag: "direct", protocol: "freedom" }], routing: 5 },
      { outbounds: [{ tag: "direct", protocol: "freedom" }], routing: { rules: "x" } },
      { outbounds: [{ tag: "direct", protocol: "freedom" }], routing: { rules: [5, null, "x", [], { outboundTag: 5, domain: ["a"] }, { outboundTag: "direct", domain: "строкой", ip: [1, null] }] } },
      { outbounds: "x", routing: { rules: [{ outboundTag: "direct", domain: ["a"] }] } },
      { outbounds: [5, null, { tag: 7, protocol: "freedom" }, { tag: "direct" }], routing: { rules: [{ outboundTag: "direct", domain: ["a"] }] } },
      null,
      5,
      "x",
      [],
    ];
    expect(() => routingOfConfigs(garbage)).not.toThrow();
    // правило с domain строкой и ip из не-строк записей не даёт, но само правило без записей — одна запись
    expect(routingOfConfigs(garbage)).toEqual({ sources: ["json"], direct: 1, block: 0, hints: [] });
    expect(routingOfConfigs([])).toBeNull();
    expect(routingOfConfigs([{ routing: 5 }, { outbounds: [], routing: { rules: "x" } }])).toBeNull();
  });
});

describe("parseRoutingHeader: заголовок поставщика", () => {
  const PAYLOAD = { DirectSites: ["geosite:category-ru"], DirectIp: ["geoip:ru"], BlockSites: [] };

  it("happ://routing/onadd/<base64>: мимо туннеля — DirectSites и DirectIp, блокировка — Block*, подсказки обе", () => {
    expect(parseRoutingHeader(happ(PAYLOAD))).toEqual({ sources: ["header"], direct: 2, block: 0, hints: ["geosite:category-ru", "geoip:ru"] });
  });

  it("add вместо onadd и URL-safe base64 без «=» — то же самое", () => {
    const expected = parseRoutingHeader(happ(PAYLOAD));
    expect(parseRoutingHeader(happ(PAYLOAD, { verb: "add" }))).toEqual(expected);
    expect(parseRoutingHeader(happ(PAYLOAD, { url: true }))).toEqual(expected);
  });

  it("блокировки: BlockSites и BlockIp; сырые домены считаются, но подсказкой не становятся", () => {
    const payload = { DirectSites: ["domain:example.com", "GEOSITE:Category-RU"], BlockSites: ["geosite:category-ads-all", "ads.example.org"], BlockIp: ["198.51.100.0/24"] };
    expect(parseRoutingHeader(happ(payload))).toEqual({ sources: ["header"], direct: 2, block: 3, hints: ["geosite:category-ru"] });
  });

  it("не строки и не массивы в списках пропускаются; повторы схлопываются", () => {
    const payload = { DirectSites: ["geosite:a", "geosite:a", 5, null, ""], DirectIp: "не массив", BlockSites: { x: 1 } };
    expect(parseRoutingHeader(happ(payload))).toEqual({ sources: ["header"], direct: 1, block: 0, hints: ["geosite:a"] });
  });

  it("пустые списки — заголовок есть, записей нет: числа нули, а не «не разобран»", () => {
    expect(parseRoutingHeader(happ({ DirectSites: [], DirectIp: [], BlockSites: [], BlockIp: [] }))).toEqual({ sources: ["header"], direct: 0, block: 0, hints: [] });
  });

  it("нечитаемое значение даёт «есть, состав не разобран», а не ошибку", () => {
    const longValue = `happ://routing/onadd/${"A".repeat(20_000)}`;
    const notJson = `happ://routing/add/${Buffer.from("не json", "utf8").toString("base64")}`;
    const notObject = `happ://routing/add/${Buffer.from("[1,2]", "utf8").toString("base64")}`;
    const noLists = happ({ Name: "профиль", GlobalProxy: "true" });
    for (const value of ["happ://routing/add/!!!", "something-else", "x".repeat(20_000), longValue, notJson, notObject, noLists, "happ://routing/add/", "happ://routing/onadd"]) {
      expect(parseRoutingHeader(value), value.slice(0, 40)).toEqual(UNPARSED);
    }
  });

  it("null, пусто и одни пробелы — заголовка нет", () => {
    expect(parseRoutingHeader(null)).toBeNull();
    expect(parseRoutingHeader("")).toBeNull();
    expect(parseRoutingHeader("   ")).toBeNull();
  });

  it("предел 16 384 знаков: ниже предела значение читается, выше — «не разобран» даже при верном формате", () => {
    const within = happ({ DirectSites: ["d".repeat(12_250)] });
    const beyond = happ({ DirectSites: ["d".repeat(12_400)] });
    expect(within.length).toBeLessThanOrEqual(16_384);
    expect(beyond.length).toBeGreaterThan(16_384);

    expect(parseRoutingHeader(within)).toEqual({ sources: ["header"], direct: 1, block: 0, hints: [] });
    expect(parseRoutingHeader(beyond)).toEqual(UNPARSED);
  });
});

describe("mergeRouting и hasOwnRouting", () => {
  const json = (rules: unknown): RoutingSummary | null => routingOfConfigs([config(rules)]);

  it("одна запись в JSON и в заголовке считается один раз; источники — json, header", () => {
    const fromJson = json([toDirect({ domain: ["geosite:category-ru"] }), toBlock({ domain: ["ads.example.org"] })]);
    const fromHeader = parseRoutingHeader(happ({ DirectSites: ["geosite:category-ru"], DirectIp: ["geoip:ru"], BlockSites: ["ads.example.org", "tracker.example.org"] }));

    const merged = mergeRouting(fromJson, fromHeader);
    expect(merged).toEqual({ sources: ["json", "header"], direct: 2, block: 2, hints: ["geosite:category-ru", "geoip:ru"] });
    // порядок аргументов на порядок источников не влияет
    expect(mergeRouting(fromHeader, fromJson)?.sources).toEqual(["json", "header"]);
  });

  it("подсказки после объединения — снова не больше 8", () => {
    const many = (prefix: string): Json => toDirect({ domain: Array.from({ length: 6 }, (_, index) => `geosite:${prefix}${String(index)}`) });
    const merged = mergeRouting(json([many("a")]), json([many("b")]));
    expect(merged?.direct).toBe(12);
    expect(merged?.hints).toHaveLength(8);
    expect(merged?.hints.slice(0, 6)).toEqual(Array.from({ length: 6 }, (_, index) => `geosite:a${String(index)}`));
  });

  it("у одного источника числа null — в итоге числа второго", () => {
    const fromJson = json([toDirect({ domain: ["geosite:category-ru"] }), toBlock({ ip: ["geoip:cn"] })]);
    expect(mergeRouting(fromJson, UNPARSED)).toEqual({ sources: ["json", "header"], direct: 1, block: 1, hints: ["geosite:category-ru"] });
    expect(mergeRouting(UNPARSED, fromJson)).toEqual({ sources: ["json", "header"], direct: 1, block: 1, hints: ["geosite:category-ru"] });
    expect(mergeRouting(UNPARSED, UNPARSED)).toEqual(UNPARSED);
  });

  it("одного источника нет — берётся другой как есть; обоих нет — null", () => {
    const fromJson = json([toDirect({ domain: ["a.example.com"] })]);
    expect(mergeRouting(fromJson, null)).toEqual(fromJson);
    expect(mergeRouting(null, fromJson)).toEqual(fromJson);
    expect(mergeRouting(null, null)).toBeNull();
  });

  it("объединение исходные сводки не меняет", () => {
    const fromJson = json([toDirect({ domain: ["a.example.com"] })]);
    const fromHeader = parseRoutingHeader(happ({ DirectSites: ["b.example.com"] }));
    const before = structuredClone([fromJson, fromHeader]);
    mergeRouting(fromJson, fromHeader);
    expect([fromJson, fromHeader]).toEqual(before);
  });

  it("сводка, собранная руками (без записей), складывается числами, а подсказки объединяются без повторов", () => {
    const a: RoutingSummary = { sources: ["json"], direct: 3, block: 1, hints: ["geoip:ru"] };
    const b: RoutingSummary = { sources: ["header"], direct: 2, block: 0, hints: ["geoip:ru", "geosite:x"] };
    expect(mergeRouting(a, b)).toEqual({ sources: ["json", "header"], direct: 5, block: 1, hints: ["geoip:ru", "geosite:x"] });
  });

  it("своя маршрутизация есть, если нашлась запись мимо туннеля или блокировки либо пришёл заголовок", () => {
    expect(hasOwnRouting(null)).toBe(false);
    expect(hasOwnRouting(json([toProxy({ domain: ["geosite:google"] })]))).toBe(false);
    expect(hasOwnRouting(json([toDirect({ domain: ["a.example.com"] })]))).toBe(true);
    expect(hasOwnRouting(json([toBlock({ domain: ["a.example.com"] })]))).toBe(true);
    expect(hasOwnRouting(UNPARSED)).toBe(true);
    expect(hasOwnRouting(parseRoutingHeader(happ({ DirectSites: [] })))).toBe(true);
    expect(hasOwnRouting({ sources: ["json"], direct: 0, block: 0, hints: [] })).toBe(false);
  });
});
