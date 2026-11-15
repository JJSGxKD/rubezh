import { decodeBase64 } from "./internal/base64.js";

/**
 * Своя маршрутизация подписки — сведения для панели, а не часть перебора: наш
 * перебор её не применяет. Два источника, которые подписка и так отдаёт:
 * JSON-конфиги Xray (правила `routing.rules` с выходом `freedom` или `blackhole`)
 * и заголовок ответа `routing`, который панели выдают для клиента Happ
 * (`happ://routing/add/<base64>` или `happ://routing/onadd/<base64>`). Ссылки и
 * base64 маршрутизации не несут.
 *
 * Считаются записи, а не правила: домены, IP и списки `geosite:`/`geoip:`.
 * Повторы между конфигами и источниками считаются один раз. Сырые домены и IP
 * наружу не выходят — только число; в подсказки идут одни имена списков.
 */

export interface RoutingSummary {
  /** откуда известно: JSON-конфиг подписки, заголовок поставщика (в порядке `json`, `header`) */
  sources: ("json" | "header")[];
  /** записей мимо туннеля; `null` — заголовок есть, состав не разобран */
  direct: number | null;
  /** записей, которые блокируются; `null` — как у `direct` */
  block: number | null;
  /** `geosite:`/`geoip:` из записей мимо туннеля, до 8, строчными, по первому появлению */
  hints: string[];
}

/** Длиннее — заголовок есть, но читать его не берёмся: это не маршрутизация клиента, а мусор или атака. */
const HEADER_MAX = 16_384;
const HINTS_MAX = 8;
const HINT = /^(geosite|geoip):[a-z0-9._!@-]{1,56}$/;
const HAPP_ROUTING = /^happ:\/\/routing\/(?:on)?add\/(.+)$/;
const SOURCE_ORDER = ["json", "header"] as const;
/** Поля правила, которые записью не считаются: тег выхода у разных конфигов разный, а правило одно и то же. */
const RULE_META: ReadonlySet<string> = new Set(["type", "outboundTag", "balancerTag", "ruleTag"]);
/** Глубже правила Xray не бывают; предел защищает от рекурсии по вложенному мусору. */
const KEY_DEPTH_MAX = 6;

/** Записи сводки: по ним объединяются источники. Наружу из модуля не выходят. */
interface Entries {
  direct: Set<string>;
  block: Set<string>;
}

/**
 * Сводка не хранит записи в своих полях (в панель и в базу идут только числа),
 * а объединение двух источников без записей не посчитать: общие записи удвоились
 * бы. Поэтому записи лежат рядом, под самой сводкой; сводка, собранная руками,
 * их не имеет и складывается числами.
 */
const entriesBySummary = new WeakMap<RoutingSummary, Entries>();

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const normalized = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap((item) => (typeof item === "string" && item.trim() !== "" ? [item.trim().toLowerCase()] : [])) : [];

function hintsOf(direct: ReadonlySet<string>): string[] {
  const hints: string[] = [];
  for (const entry of direct) {
    if (hints.length >= HINTS_MAX) break;
    if (HINT.test(entry)) hints.push(entry);
  }
  return hints;
}

function summarize(sources: RoutingSummary["sources"], entries: Entries): RoutingSummary {
  const summary: RoutingSummary = { sources, direct: entries.direct.size, block: entries.block.size, hints: hintsOf(entries.direct) };
  entriesBySummary.set(summary, entries);
  return summary;
}

/** Заголовок есть, а состав прочитать не вышло: «есть, состав не разобран». */
const unparsed = (): RoutingSummary => ({ sources: ["header"], direct: null, block: null, hints: [] });

/** Значение без порядка ключей и без служебных полей, с пределом глубины: для ключа правила без `domain` и `ip`. */
function canonical(value: unknown, depth = 0): unknown {
  if (depth > KEY_DEPTH_MAX) return null;
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => depth > 0 || !RULE_META.has(key))
        .sort()
        .map((key) => [key, canonical(value[key], depth + 1)]),
    );
  }
  return value;
}

/** Записи правила: элементы `domain` и `ip`; у правила без них (порт, протокол, сеть) — одна запись, само правило. */
function ruleEntries(rule: Record<string, unknown>): string[] {
  const listed = [...normalized(rule["domain"]), ...normalized(rule["ip"])];
  return listed.length > 0 ? listed : [JSON.stringify(canonical(rule))];
}

/** Тег выхода → протокол выхода (строчными), по первому выходу с таким тегом. */
function protocolsOf(outbounds: unknown): Map<string, string> {
  const protocols = new Map<string, string>();
  if (!Array.isArray(outbounds)) return protocols;
  for (const outbound of outbounds) {
    if (!isObject(outbound) || typeof outbound["tag"] !== "string" || typeof outbound["protocol"] !== "string") continue;
    if (!protocols.has(outbound["tag"])) protocols.set(outbound["tag"], outbound["protocol"].toLowerCase());
  }
  return protocols;
}

/**
 * Маршрутизация из JSON-конфигов подписки. Правило с `outboundTag` на выход
 * `freedom` идёт в «мимо туннеля», на `blackhole` — в «блокируется»; правила в
 * другие выходы и в балансировщик не считаются. Мусор вместо конфига, `routing`
 * или правила пропускается молча: это сведения, а не узлы. Записей нет — `null`.
 */
export function routingOfConfigs(configs: readonly unknown[]): RoutingSummary | null {
  const entries: Entries = { direct: new Set(), block: new Set() };
  for (const config of configs) {
    if (!isObject(config) || !isObject(config["routing"])) continue;
    const rules = config["routing"]["rules"];
    if (!Array.isArray(rules)) continue;
    const protocols = protocolsOf(config["outbounds"]);
    for (const rule of rules) {
      if (!isObject(rule) || typeof rule["outboundTag"] !== "string") continue;
      const protocol = protocols.get(rule["outboundTag"]);
      const target = protocol === "freedom" ? entries.direct : protocol === "blackhole" ? entries.block : null;
      if (target === null) continue;
      for (const entry of ruleEntries(rule)) target.add(entry);
    }
  }
  return entries.direct.size === 0 && entries.block.size === 0 ? null : summarize(["json"], entries);
}

/**
 * Заголовок `routing` поставщика. Разбирается вид Happ: base64 (обычный или
 * URL-safe) от JSON со списками `DirectSites`, `DirectIp` (мимо туннеля) и
 * `BlockSites`, `BlockIp` (блокировка). Нет заголовка или он пуст — `null`.
 * Заголовок есть, а прочитать не вышло (другой формат, битое значение, слишком
 * длинное, ни одного из четырёх списков) — «есть, состав не разобран», не ошибка.
 */
export function parseRoutingHeader(value: string | null): RoutingSummary | null {
  if (value === null) return null;
  const text = value.trim();
  if (text === "") return null;
  if (text.length > HEADER_MAX) return unparsed();
  const payload = HAPP_ROUTING.exec(text)?.[1];
  if (payload === undefined) return unparsed();

  let decoded: string | null;
  try {
    decoded = decodeBase64(payload.includes("%") ? decodeURIComponent(payload) : payload);
  } catch {
    // Битая процентная кодировка — то же, что нечитаемое значение.
    return unparsed();
  }
  if (decoded === null) return unparsed();

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return unparsed();
  }
  if (!isObject(parsed)) return unparsed();
  const lists = ["DirectSites", "DirectIp", "BlockSites", "BlockIp"];
  if (!lists.some((name) => Array.isArray(parsed[name]))) return unparsed();

  return summarize(["header"], {
    direct: new Set([...normalized(parsed["DirectSites"]), ...normalized(parsed["DirectIp"])]),
    block: new Set([...normalized(parsed["BlockSites"]), ...normalized(parsed["BlockIp"])]),
  });
}

/**
 * Объединение источников. Числа складываются после схлопывания повторов, поэтому
 * объединяются записи, а не числа. Источник без чисел (заголовок не разобран) в
 * счёт ничего не вносит: в итоге числа второго. Исходные сводки не меняются.
 */
export function mergeRouting(a: RoutingSummary | null, b: RoutingSummary | null): RoutingSummary | null {
  if (a === null) return b;
  if (b === null) return a;
  const sources = SOURCE_ORDER.filter((source) => a.sources.includes(source) || b.sources.includes(source));
  const parts = [a, b].map((summary) => ({ summary, entries: entriesBySummary.get(summary) ?? null }));
  const countable = (part: (typeof parts)[number]): boolean => part.entries !== null || part.summary.direct !== null || part.summary.block !== null;

  if (!parts.some(countable)) return { sources, direct: null, block: null, hints: [] };

  if (parts.every((part) => part.entries !== null || !countable(part))) {
    const merged: Entries = { direct: new Set(), block: new Set() };
    for (const { entries } of parts) {
      for (const entry of entries?.direct ?? []) merged.direct.add(entry);
      for (const entry of entries?.block ?? []) merged.block.add(entry);
    }
    return summarize(sources, merged);
  }

  // Сводка без записей (собрана руками): общие записи не отличить, числа складываются.
  const sum = (pick: (part: (typeof parts)[number]) => number | null): number => parts.reduce((total, part) => total + (pick(part) ?? 0), 0);
  return {
    sources,
    direct: sum((part) => part.entries?.direct.size ?? part.summary.direct),
    block: sum((part) => part.entries?.block.size ?? part.summary.block),
    hints: [...new Set(parts.flatMap((part) => part.summary.hints))].slice(0, HINTS_MAX),
  };
}

/** Есть ли у подписки своя маршрутизация: нашлась запись мимо туннеля или блокировки либо пришёл заголовок `routing`. */
export function hasOwnRouting(summary: RoutingSummary | null): boolean {
  if (summary === null) return false;
  return (summary.direct ?? 0) > 0 || (summary.block ?? 0) > 0 || summary.sources.includes("header");
}
