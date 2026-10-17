import { createHash } from "node:crypto";
import { countryOfName } from "../country.js";
import type { NodeNetwork, NodeSecurity, NodeTransport, ProxyNode, ShareLinkResult, SkipReason } from "../node.js";

export type Fail = Extract<ShareLinkResult, { ok: false }>;

/** Отказ. `detail` — имя параметра или схема, не кусок ссылки: в ссылке секреты. */
export function fail(reason: SkipReason, detail: string): Fail {
  return { ok: false, reason, detail };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Узел без ключа и страны: их досчитывает `finishNode`. */
export type NodeDraft = Omit<ProxyNode, "key" | "country">;

/**
 * Ключ — 16 hex от sha256 по тому, что делает узел узлом: название на него не
 * влияет, поэтому переименование узла в подписке не сбрасывает его слот и
 * здоровье.
 */
export function finishNode(draft: NodeDraft): ProxyNode {
  const identity = [draft.protocol, draft.host, draft.port, draft.secret, canonicalTransport(draft.transport), canonicalSecurity(draft.security)].join("|");
  return { ...draft, key: createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 16), country: countryOfName(draft.name) };
}

function canonicalTransport(transport: NodeTransport): string {
  return [transport.network, transport.path ?? "", transport.host ?? "", transport.serviceName ?? "", transport.mode ?? ""].join(",");
}

function canonicalSecurity(security: NodeSecurity): string {
  switch (security.kind) {
    case "none":
      return "none";
    case "tls":
      return ["tls", security.serverName, security.alpn.join(","), security.fingerprint ?? ""].join(",");
    case "reality":
      return ["reality", security.serverName, security.fingerprint, security.publicKey, security.shortId, security.spiderX].join(",");
  }
}

const NETWORKS: ReadonlySet<string> = new Set<NodeNetwork>(["tcp", "ws", "grpc", "httpupgrade", "xhttp"]);

/** Сеть транспорта; `raw` — новое имя `tcp` в Xray. `null` — не поддерживается. */
export function networkOf(value: string): NodeNetwork | null {
  const name = value === "raw" ? "tcp" : value;
  return NETWORKS.has(name) ? (name as NodeNetwork) : null;
}

/** Параметры, которых мы не умеем: пропуск узла, а не догадка о том, что имелось в виду. */
const UNSUPPORTED_FLAGS = ["allowInsecure", "insecure"] as const;
const UNSUPPORTED_VALUES = ["pcs", "vcn", "ech", "pqv"] as const;

/** Первый неподдерживаемый параметр безопасности; `null` — таких нет. */
export function unsupportedOption(params: URLSearchParams): string | null {
  for (const name of UNSUPPORTED_FLAGS) {
    const value = params.get(name);
    if (value !== null && ["1", "true", "yes"].includes(value.toLowerCase())) return name;
  }
  for (const name of UNSUPPORTED_VALUES) {
    if ((params.get(name) ?? "") !== "") return name;
  }
  return null;
}

export function listOf(value: string | null): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter((item) => item !== "");
}

export type StreamResult = { ok: true; transport: NodeTransport; security: NodeSecurity } | Fail;

/**
 * Транспорт и безопасность из параметров запроса — общие для vless,
 * адресной формы vmess и trojan. `defaultSecurity`: у trojan без `security`
 * подразумевается tls, у остальных — ничего.
 */
export function streamFromParams(params: URLSearchParams, host: string, defaultSecurity: "none" | "tls"): StreamResult {
  const option = unsupportedOption(params);
  if (option !== null) return fail("unsupported_option", option);

  const network = networkOf(params.get("type") ?? "tcp");
  if (network === null) return fail("unsupported_transport", "type");
  if (network === "tcp" && !["", "none"].includes(params.get("headerType") ?? "")) return fail("unsupported_option", "headerType");

  const transport: NodeTransport = { network };
  const path = params.get("path");
  const hostHeader = params.get("host");
  if (network === "ws" || network === "httpupgrade" || network === "xhttp") {
    if (path !== null && path !== "") transport.path = path;
    if (hostHeader !== null && hostHeader !== "") transport.host = hostHeader;
  }
  if (network === "grpc" && (params.get("serviceName") ?? "") !== "") transport.serviceName = params.get("serviceName") ?? "";
  if ((network === "grpc" || network === "xhttp") && (params.get("mode") ?? "") !== "") transport.mode = params.get("mode") ?? "";

  const security = securityFromParams(params, host, defaultSecurity);
  return security.ok ? { ok: true, transport, security: security.security } : security;
}

function securityFromParams(params: URLSearchParams, host: string, defaultSecurity: "none" | "tls"): { ok: true; security: NodeSecurity } | Fail {
  const kind = params.get("security") ?? defaultSecurity;
  const serverName = (params.get("sni") ?? "") !== "" ? (params.get("sni") ?? host) : host;
  const fingerprint = (params.get("fp") ?? "") !== "" ? (params.get("fp") ?? null) : null;

  if (kind === "none" || kind === "") return { ok: true, security: { kind: "none" } };
  if (kind === "tls") return { ok: true, security: { kind: "tls", serverName, alpn: listOf(params.get("alpn")), fingerprint } };
  if (kind === "reality") {
    const publicKey = params.get("pbk") ?? "";
    if (publicKey === "") return fail("malformed", "pbk");
    return {
      ok: true,
      security: { kind: "reality", serverName, fingerprint: fingerprint ?? "chrome", publicKey, shortId: params.get("sid") ?? "", spiderX: params.get("spx") ?? "" },
    };
  }
  return fail("unsupported_option", "security");
}
