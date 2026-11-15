import { createHash } from "node:crypto";
import { countryOfName } from "../country.js";
import { canonicalJson, jsonObjectOf } from "../internal/json.js";
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
  const identity = [draft.protocol, draft.host, draft.port, draft.secret, canonicalTransport(draft.transport), canonicalSecurity(draft.security), ...canonicalExtras(draft)].join("|");
  return { ...draft, key: createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 16), country: countryOfName(draft.name) };
}

/**
 * Что добавили задачи после первой версии ключа (Р192, T-0387): части дописываются
 * в постоянном порядке и только если заданы, поэтому ключ узла без них прежний —
 * его слот и здоровье переживают выкатку.
 */
function canonicalExtras(draft: NodeDraft): string[] {
  const { transport, security } = draft;
  const parts: string[] = [];
  if (transport.extra !== undefined) parts.push(`x=${canonicalJson(transport.extra)}`);
  if (transport.rawHeader !== undefined) parts.push(`h=${canonicalJson(transport.rawHeader)}`);
  if (security.kind === "tls") {
    if (security.ech !== undefined) parts.push(`ech=${security.ech}`);
    if (security.echForceQuery !== undefined) parts.push(`efq=${security.echForceQuery}`);
    if (security.pinnedPeerCertSha256 !== undefined) parts.push(`pcs=${security.pinnedPeerCertSha256}`);
    if (security.verifyPeerCertByName !== undefined) parts.push(`vcn=${security.verifyPeerCertByName}`);
    if (security.legacyPinning !== undefined) parts.push(`lp=${canonicalJson(security.legacyPinning)}`);
  }
  if (security.kind === "reality" && security.mldsa65Verify !== undefined) parts.push(`pqv=${security.mldsa65Verify}`);
  if (draft.protocol === "vless" && draft.cipher !== null) parts.push(`enc=${draft.cipher}`);
  if (draft.dialer !== undefined) parts.push(`d=${canonicalJson(draft.dialer.settings)}`);
  return parts;
}

/** Поле объекта только если оно задано: без `undefined`-ключей, которые схема узла и сравнения не прощают. */
export function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

/** Строка из ссылки или JSON после проверки: пусто — «не задано». */
export type Checked = { ok: true; value: string | undefined } | Fail;

/** Видимые знаки ASCII, 1…4096: пробелы, управляющие и не-ASCII знаки в параметре — ошибка ссылки. */
export const VISIBLE_TEXT = /^[!-~]{1,4096}$/;
/** sha256 сертификата, 64 hex; несколько через запятую: короче Xray отвергает весь конфиг. */
export const PIN_SHA256 = /^[0-9a-fA-F]{64}(,[0-9a-fA-F]{64})*$/;
export const BASE64URL_TEXT = /^[A-Za-z0-9_-]{1,4096}$/;

/**
 * Строка по правилу: пусто — не задано, иначе строка, подходящая под `pattern`.
 * Значения не по правилу не пропускаются в конфиг: Xray отвергает его целиком,
 * а в нём узлы всех подписок. Причина несёт имя параметра, но не значение.
 */
export function checkedText(raw: unknown, detail: string, pattern: RegExp = VISIBLE_TEXT): Checked {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
  return typeof raw === "string" && pattern.test(raw) ? { ok: true, value: raw } : fail("malformed", detail);
}

/** Режимы `flow`, которые Xray ещё знает; остальные (`direct`, `origin`, `splice`) убраны из ядра. */
export const VLESS_FLOWS: ReadonlySet<string> = new Set(["xtls-rprx-vision", "xtls-rprx-vision-udp443"]);

const VLESS_ENCRYPTION = /^mlkem768x25519plus\.[!-~]{1,4000}$/;

/**
 * Шифрование самого VLESS: `none` и пусто — без него (`null`), постквантовая строка
 * уходит в конфиг как есть. Формат проверяется: что Xray не разбирает, он не принимает
 * вместе со всем конфигом.
 */
export function vlessEncryption(value: string | undefined): { ok: true; cipher: string | null } | Fail {
  if (value === undefined || value === "" || value === "none") return { ok: true, cipher: null };
  return VLESS_ENCRYPTION.test(value) ? { ok: true, cipher: value } : fail("malformed", "encryption");
}

const HEADER_ITEM = /^[!-~]{1,256}$/;

/**
 * Заголовок HTTP-маскировки RAW из списков `path` и `host`: без `path` — «/»,
 * без `host` заголовка `Host` нет. `null` — в элементе знак, которому в заголовке
 * не место (перевод строки позволил бы дописать чужой заголовок).
 */
export function httpRawHeader(paths: readonly string[], hosts: readonly string[]): Record<string, unknown> | null {
  if (![...paths, ...hosts].every((item) => HEADER_ITEM.test(item))) return null;
  return { type: "http", request: { path: paths.length > 0 ? [...paths] : ["/"], headers: hosts.length > 0 ? { Host: [...hosts] } : {} } };
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

/**
 * Параметры, которых мы не умеем: пропуск узла, а не догадка о том, что имелось в виду.
 * Это отключение проверки сертификата узла: туннель с ним можно подменить.
 */
const UNSUPPORTED_FLAGS = ["allowInsecure", "insecure"] as const;

/** Первый неподдерживаемый параметр безопасности; `null` — таких нет. */
export function unsupportedOption(params: URLSearchParams): string | null {
  for (const name of UNSUPPORTED_FLAGS) {
    const value = params.get(name);
    if (value !== null && ["1", "true", "yes"].includes(value.toLowerCase())) return name;
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

  const transport: NodeTransport = { network };
  if (network === "tcp") {
    const header = tcpHeaderOf(params.get("headerType") ?? "", listOf(params.get("path")), listOf(params.get("host")));
    if (!header.ok) return header;
    if (header.rawHeader !== undefined) transport.rawHeader = header.rawHeader;
  }
  if (network === "xhttp" && (params.get("extra") ?? "") !== "") {
    const extra = extraOf(params.get("extra"));
    if (extra === null) return fail("malformed", "extra");
    // Пустой объект — «настроек нет»: узел не должен отличаться от такого же без параметра.
    if (Object.keys(extra).length > 0) transport.extra = extra;
  }
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
  if (kind === "tls") {
    const ech = checkedText(params.get("ech"), "ech");
    if (!ech.ok) return ech;
    const pin = checkedText(params.get("pcs"), "pcs", PIN_SHA256);
    if (!pin.ok) return pin;
    const byName = checkedText(params.get("vcn"), "vcn");
    if (!byName.ok) return byName;
    return {
      ok: true,
      security: {
        kind: "tls",
        serverName,
        alpn: listOf(params.get("alpn")),
        fingerprint,
        ...optional("ech", ech.value),
        ...optional("pinnedPeerCertSha256", pin.value),
        ...optional("verifyPeerCertByName", byName.value),
      },
    };
  }
  if (kind === "reality") {
    const publicKey = params.get("pbk") ?? "";
    if (publicKey === "") return fail("malformed", "pbk");
    const postQuantum = checkedText(params.get("pqv"), "pqv", BASE64URL_TEXT);
    if (!postQuantum.ok) return postQuantum;
    return {
      ok: true,
      security: {
        kind: "reality",
        serverName,
        fingerprint: fingerprint ?? "chrome",
        publicKey,
        shortId: params.get("sid") ?? "",
        spiderX: params.get("spx") ?? "",
        ...optional("mldsa65Verify", postQuantum.value),
      },
    };
  }
  return fail("unsupported_option", "security");
}

/**
 * Заголовок RAW у tcp: `none` и пусто — без него, `http` — HTTP-маскировка из `path` и
 * `host`, остальное (`srtp`, `utp`, `wechat-video`…) мы не собираем. `Fail` по `type`
 * называет параметр ссылки, а по `type` JSON-формы vmess — его имя (`detail`).
 */
export function tcpHeaderOf(kind: string, paths: readonly string[], hosts: readonly string[], detail = "headerType"): { ok: true; rawHeader?: Record<string, unknown> } | Fail {
  if (kind === "" || kind === "none") return { ok: true };
  if (kind !== "http") return fail("unsupported_option", detail);
  const rawHeader = httpRawHeader(paths, hosts);
  return rawHeader === null ? fail("malformed", detail) : { ok: true, rawHeader };
}

/** `extra` из ссылки: JSON-объект в пределах `jsonObjectOf`; `null` — не он. */
function extraOf(text: string | null): Record<string, unknown> | null {
  try {
    return jsonObjectOf(JSON.parse(text ?? "") as unknown);
  } catch {
    return null;
  }
}
