import { z } from "zod";
import type { ProxyNode } from "../node.js";
import type { SkippedLink } from "../subscription.js";
import { parseOutbound } from "./outbound.js";

/**
 * JSON-подписка Xray: массив полных конфигов (`[{ remarks, outbounds: [...] }]`) —
 * так отдают Remnawave, Marzban и клиенты Happ — либо один такой конфиг.
 * Узлы — выходы с протоколом vless, vmess, trojan или shadowsocks; имя узла —
 * `remarks` конфига. Служебные выходы (`freedom`, `blackhole`, `dns`) не узлы и
 * в пропуски не попадают; остальные протоколы — пропуск с причиной.
 */

const SERVICE_PROTOCOLS: ReadonlySet<string> = new Set(["freedom", "blackhole", "dns"]);

/** Схема, по которой протокол попадает в `scheme` пропуска: из JSON туда не должно попасть что попало. */
const SCHEME = /^[a-z][a-z0-9+.-]{0,31}$/;

const config = z.object({ remarks: z.unknown().optional(), outbounds: z.array(z.unknown()) });
const withProtocol = z.object({ protocol: z.string() });

export type XrayJsonResult =
  | { kind: "ok"; nodes: ProxyNode[]; skipped: SkippedLink[]; truncated: boolean }
  | { kind: "unsupported_format" | "empty" };

interface Candidate {
  /** протокол выхода строчными либо `unknown`, если на протокол не похоже: в пропуск попадает только он */
  scheme: string;
  outbound: unknown;
  remarks: string;
}

/** Тело подписки похоже на JSON: ссылки и base64 не начинаются ни с `[`, ни с `{`. */
export const looksLikeJson = (text: string): boolean => text.startsWith("[") || text.startsWith("{");

/**
 * `maxLinks` считает выходы-кандидаты (не служебные), как ссылки: остальные не
 * разбираются, `truncated` говорит об этом. Размер тела ограничен загрузкой.
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

  const candidates: Candidate[] = [];
  let configs = 0;
  let outbounds = 0;
  let typed = 0;
  for (const item of Array.isArray(raw) ? raw : [raw]) {
    const parsed = config.safeParse(item);
    if (!parsed.success) continue;
    configs++;
    const remarks = typeof parsed.data.remarks === "string" ? parsed.data.remarks : "";
    for (const outbound of parsed.data.outbounds) {
      outbounds++;
      const header = withProtocol.safeParse(outbound);
      if (!header.success) continue;
      typed++;
      const protocol = header.data.protocol.toLowerCase();
      const scheme = SCHEME.test(protocol) ? protocol : "unknown";
      if (!SERVICE_PROTOCOLS.has(protocol)) candidates.push({ scheme, outbound, remarks });
    }
  }

  if (configs === 0) return { kind: "unsupported_format" };
  if (candidates.length === 0) {
    // Выходы есть, но ни у одного нет `protocol`: чужой формат (sing-box, у него `type`), а не пустой конфиг.
    return { kind: outbounds > 0 && typed === 0 ? "unsupported_format" : "empty" };
  }

  const nodes = new Map<string, ProxyNode>();
  const skipped: SkippedLink[] = [];
  candidates.slice(0, maxLinks).forEach((candidate, index) => {
    const result = parseOutbound(candidate.scheme, candidate.outbound, candidate.remarks);
    if (result.ok) {
      if (!nodes.has(result.node.key)) nodes.set(result.node.key, result.node);
      return;
    }
    skipped.push({ index, scheme: candidate.scheme, reason: result.reason, detail: result.detail });
  });
  return { kind: "ok", nodes: [...nodes.values()], skipped, truncated: candidates.length > maxLinks };
}
