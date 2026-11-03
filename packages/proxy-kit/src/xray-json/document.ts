import { z } from "zod";
import type { ProxyNode } from "../node.js";
import type { SkippedLink } from "../subscription.js";
import { parseOutbound } from "./outbound.js";

/**
 * JSON-подписка Xray: массив полных конфигов (`[{ remarks, outbounds: [...] }]`) —
 * так отдают Remnawave, Marzban и клиенты Happ — либо один такой конфиг.
 * Узлы — выходы с протоколом vless, vmess, trojan или shadowsocks; имя узла —
 * `remarks` конфига. Служебные выходы (`freedom`, `blackhole`, `dns`) не узлы и
 * в пропуски не попадают; остальные протоколы — пропуск с причиной. Элемент,
 * который не конфиг, и выход без протокола — тоже пропуск (`malformed`), а не тишина.
 */

const SERVICE_PROTOCOLS: ReadonlySet<string> = new Set(["freedom", "blackhole", "dns"]);

/** Схема, по которой протокол попадает в `scheme` пропуска: из JSON туда не должно попасть что попало. */
const SCHEME = /^[a-z][a-z0-9+.-]{0,31}$/;

const config = z.object({ remarks: z.unknown().optional(), outbounds: z.array(z.unknown()) });
const withProtocol = z.object({ protocol: z.string() });

export type XrayJsonResult =
  | { kind: "ok"; nodes: ProxyNode[]; skipped: SkippedLink[]; truncated: boolean }
  | { kind: "unsupported_format" | "empty" };

/** Что разбирается и считается в `maxLinks`: выход-узел либо то, что выходом не оказалось. */
type Item =
  | {
      kind: "outbound";
      /** протокол выхода строчными либо `unknown`, если на протокол не похоже: в пропуск попадает только он */
      scheme: string;
      outbound: unknown;
      remarks: string;
    }
  | { kind: "problem"; detail: "config" | "outbounds" | "protocol" };

/** Тело подписки похоже на JSON: ссылки и base64 не начинаются ни с `[`, ни с `{`. */
export const looksLikeJson = (text: string): boolean => text.startsWith("[") || text.startsWith("{");

/** Объект, а не `null`, список или число: остальное в схему Zod не отдаётся, чтобы мусор не плодил её ошибки. */
const isObject = (value: unknown): value is object => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `maxLinks` считает выходы-кандидаты (не служебные) и мусор вместо них, как
 * ссылки: остальное не разбирается, `truncated` говорит об этом. Размер тела
 * ограничен загрузкой.
 *
 * Формат Xray узнаётся по выходам с `protocol`. Нет ни одного — это чужой JSON
 * (sing-box с `type`, `{}`, список чисел) либо пустой конфиг, и тогда
 * `unsupported_format` или `empty`, а не россыпь пропусков.
 */
export function parseXrayJson(text: string, maxLinks: number): XrayJsonResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Битый JSON и слишком глубокая вложенность (RangeError) — одно и то же: не наш формат.
    return { kind: "unsupported_format" };
  }
  if (Array.isArray(raw) && raw.length === 0) return { kind: "empty" };

  // Хранится не больше `maxLinks` элементов: длинный хвост мусора только считается.
  const items: Item[] = [];
  let total = 0;
  const add = (item: Item): void => {
    total++;
    if (items.length < maxLinks) items.push(item);
  };

  let configs = 0;
  let typed = 0;
  let problems = 0;
  for (const element of Array.isArray(raw) ? raw : [raw]) {
    const parsed = isObject(element) ? config.safeParse(element) : null;
    if (parsed === null || !parsed.success) {
      problems++;
      add({ kind: "problem", detail: parsed === null ? "config" : "outbounds" });
      continue;
    }
    configs++;
    const remarks = typeof parsed.data.remarks === "string" ? parsed.data.remarks : "";
    for (const outbound of parsed.data.outbounds) {
      const header = isObject(outbound) ? withProtocol.safeParse(outbound) : null;
      if (header === null || !header.success) {
        problems++;
        add({ kind: "problem", detail: "protocol" });
        continue;
      }
      typed++;
      const protocol = header.data.protocol.toLowerCase();
      if (!SERVICE_PROTOCOLS.has(protocol)) add({ kind: "outbound", scheme: SCHEME.test(protocol) ? protocol : "unknown", outbound, remarks });
    }
  }

  if (typed === 0) return { kind: configs > 0 && problems === 0 ? "empty" : "unsupported_format" };
  if (total === 0) return { kind: "empty" };

  const nodes = new Map<string, ProxyNode>();
  const skipped: SkippedLink[] = [];
  items.forEach((item, index) => {
    if (item.kind === "problem") {
      skipped.push({ index, scheme: "unknown", reason: "malformed", detail: item.detail });
      return;
    }
    const result = parseOutbound(item.scheme, item.outbound, item.remarks);
    if (result.ok) {
      if (!nodes.has(result.node.key)) nodes.set(result.node.key, result.node);
      return;
    }
    skipped.push({ index, scheme: item.scheme, reason: result.reason, detail: result.detail });
  });
  return { kind: "ok", nodes: [...nodes.values()], skipped, truncated: total > maxLinks };
}
