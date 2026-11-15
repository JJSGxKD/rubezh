import { z } from "zod";
import { jsonObjectOf } from "../internal/json.js";
import type { LegacyPinning, NodeSecurity, NodeTransport } from "../node.js";
import { BASE64URL_TEXT, checkedText, fail, networkOf, optional, PIN_SHA256, VISIBLE_TEXT, type Checked, type Fail } from "../links/common.js";

/**
 * `streamSettings` выхода Xray в транспорт и безопасность узла — то же, что
 * `streamFromParams` делает с параметрами ссылки, и с теми же отказами: чего
 * не умеем, пропускается, а не угадывается. Имена полей — как в конфиге Xray
 * (обратное преобразование — `xray-config.ts`); `detail` отказа — тоже имя поля
 * либо то короткое имя, которым его называют ссылки (`pcs`, `ech`, `pqv`).
 */

/**
 * `dialerTag` — тег выхода из `sockopt.dialerProxy`, через который идёт узел; что за ним
 * стоит, решает `outbound.ts`: там видны соседние выходы конфига.
 */
export type StreamResult = { ok: true; transport: NodeTransport; security: NodeSecurity; dialerTag: string | null } | Fail;

const text = z.string().optional();

const streamSection = z.object({
  network: text,
  security: text,
  tlsSettings: z.unknown().optional(),
  realitySettings: z.unknown().optional(),
  tcpSettings: z.unknown().optional(),
  rawSettings: z.unknown().optional(),
  wsSettings: z.unknown().optional(),
  grpcSettings: z.unknown().optional(),
  httpupgradeSettings: z.unknown().optional(),
  xhttpSettings: z.unknown().optional(),
  sockopt: z.unknown().optional(),
});

const tlsSection = z.object({
  serverName: text,
  alpn: z.array(z.string()).optional(),
  fingerprint: text,
  allowInsecure: z.union([z.boolean(), z.string()]).optional(),
  pinnedPeerCertificateChainSha256: z.unknown().optional(),
  pinnedPeerCertSha256: z.unknown().optional(),
  pinnedPeerCertificatePublicKeySha256: z.unknown().optional(),
  verifyPeerCertByName: z.unknown().optional(),
  verifyPeerCertInNames: z.unknown().optional(),
  echConfigList: z.unknown().optional(),
  echForceQuery: z.unknown().optional(),
});

const realitySection = z.object({ serverName: text, fingerprint: text, publicKey: text, shortId: text, spiderX: text, mldsa65Verify: z.unknown().optional() });
const tcpSection = z.object({ header: z.unknown().optional() });
const wsSection = z.object({ path: text, host: text, headers: z.record(z.string(), z.unknown()).optional() });
const pathSection = z.object({ path: text, host: text, mode: text });
/** У xhttp кроме `path`, `host` и `mode` бывают `xPaddingBytes`, `xmux`, `downloadSettings` и другие: они идут в `extra`. */
const xhttpSection = z.looseObject({ path: text, host: text, mode: text, extra: z.unknown().optional() });
const grpcSection = z.object({ serviceName: text, multiMode: z.boolean().optional() });
const sockoptSection = z.object({ dialerProxy: z.unknown().optional() });
const headerSection = z.object({ type: z.unknown().optional() });
const objectSection = z.record(z.string(), z.unknown());

/** Есть ли в поле что-то, кроме «не задано»: пустая строка, пустой список и `false` — нет. */
export const isSet = (value: unknown): boolean => value !== undefined && value !== null && value !== "" && value !== false && !(Array.isArray(value) && value.length === 0);

/** То же, что `["1", "true", "yes"]` у ссылок: `allowInsecure` бывает булевым и строкой. */
const isOn = (value: boolean | string | undefined): boolean => value === true || (typeof value === "string" && ["1", "true", "yes"].includes(value.toLowerCase()));

/** Поле раздела, если раздел не задан — пустой объект: все поля необязательны. */
function section<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> | null {
  const parsed = schema.safeParse(value ?? {});
  return parsed.success ? parsed.data : null;
}

/** `host` — адрес узла: имя сервера по умолчанию, как `sni` у ссылки без параметра. */
export function streamFromSettings(raw: unknown, host: string): StreamResult {
  const stream = section(streamSection, raw);
  if (stream === null) return fail("malformed", "streamSettings");

  const sockopt = section(sockoptSection, stream.sockopt);
  if (sockopt === null) return fail("malformed", "sockopt");
  // Цепочка через другой выход: тег отдаётся наружу, а выход по нему ищет `outbound.ts`.
  // Что не строка, узел пропускает: тег неоткуда разобрать.
  const proxy = sockopt.dialerProxy;
  if (isSet(proxy) && typeof proxy !== "string") return fail("unsupported_option", "dialerProxy");
  const dialerTag = typeof proxy === "string" && proxy !== "" ? proxy : null;

  const network = networkOf(stream.network === undefined || stream.network === "" ? "tcp" : stream.network);
  if (network === null) return fail("unsupported_transport", "network");

  const transport: NodeTransport = { network };
  const failure = fillTransport(transport, stream);
  if (failure !== null) return failure;

  const security = securityOf(stream.security ?? "", stream, host);
  return security.ok ? { ok: true, transport, security: security.security, dialerTag } : security;
}

/** Параметры транспорта по сети; `null` — всё в порядке. */
function fillTransport(transport: NodeTransport, stream: z.infer<typeof streamSection>): Fail | null {
  const present = (value: string | undefined): string | undefined => (value === undefined || value === "" ? undefined : value);

  switch (transport.network) {
    case "tcp": {
      const tcp = section(tcpSection, stream.tcpSettings ?? stream.rawSettings);
      if (tcp === null) return fail("malformed", "tcpSettings");
      return fillRawHeader(transport, tcp.header);
    }
    case "ws": {
      const ws = section(wsSection, stream.wsSettings);
      if (ws === null) return fail("malformed", "wsSettings");
      const header = ws.headers?.["Host"] ?? ws.headers?.["host"];
      const host = present(typeof header === "string" ? header : undefined) ?? present(ws.host);
      const path = present(ws.path);
      if (path !== undefined) transport.path = path;
      if (host !== undefined) transport.host = host;
      return null;
    }
    case "httpupgrade": {
      const settings = section(pathSection, stream.httpupgradeSettings);
      if (settings === null) return fail("malformed", "httpupgradeSettings");
      const path = present(settings.path);
      const host = present(settings.host);
      if (path !== undefined) transport.path = path;
      if (host !== undefined) transport.host = host;
      return null;
    }
    case "xhttp": {
      const settings = section(xhttpSection, stream.xhttpSettings);
      if (settings === null) return fail("malformed", "xhttpSettings");
      const { path: rawPath, host: rawHost, mode: rawMode, extra, ...rest } = settings;
      const path = present(rawPath);
      const host = present(rawHost);
      const mode = present(rawMode);
      if (path !== undefined) transport.path = path;
      if (host !== undefined) transport.host = host;
      if (mode !== undefined) transport.mode = mode;
      return fillExtra(transport, extra, rest);
    }
    case "grpc": {
      const grpc = section(grpcSection, stream.grpcSettings);
      if (grpc === null) return fail("malformed", "grpcSettings");
      const serviceName = present(grpc.serviceName);
      if (serviceName !== undefined) transport.serviceName = serviceName;
      if (grpc.multiMode === true) transport.mode = "multi";
      return null;
    }
  }
}

/** Заголовок RAW: `none` и пусто — без него, `http` — объект `header` целиком, остальное мы не собираем. */
function fillRawHeader(transport: NodeTransport, header: unknown): Fail | null {
  if (header === undefined || header === null) return null;
  const parsed = section(headerSection, header);
  if (parsed === null) return fail("malformed", "tcpSettings");
  const kind = parsed.type ?? "";
  if (kind === "" || kind === "none") return null;
  if (kind !== "http") return fail("unsupported_option", "headerType");
  const rawHeader = jsonObjectOf(header);
  if (rawHeader === null) return fail("malformed", "headerType");
  transport.rawHeader = rawHeader;
  return null;
}

/**
 * Дополнительные настройки XHTTP: объект `extra` и прочие поля `xhttpSettings`, кроме
 * `path`, `host`, `mode`, — одним объектом, а при совпадении ключа `extra` важнее: так
 * его читает и сам Xray. Скачивание через цепочку (`downloadSettings` с `sockopt.dialerProxy`)
 * мы не собираем: выход цепочки в другом конфиге.
 */
function fillExtra(transport: NodeTransport, extra: unknown, rest: Record<string, unknown>): Fail | null {
  let merged = rest;
  if (isSet(extra)) {
    const object = jsonObjectOf(extra);
    if (object === null) return fail("malformed", "extra");
    merged = { ...rest, ...object };
  }
  if (Object.keys(merged).length === 0) return null;

  const bounded = jsonObjectOf(merged);
  if (bounded === null) return fail("malformed", "extra");
  const download = objectSection.safeParse(bounded["downloadSettings"]);
  if (download.success) {
    const sockopt = objectSection.safeParse(download.data["sockopt"]);
    if (sockopt.success && isSet(sockopt.data["dialerProxy"])) return fail("unsupported_option", "extra.downloadSettings");
  }
  transport.extra = bounded;
  return null;
}

/** Закрепление сертификата старыми полями: только списки строк, остальное Xray не примет. */
function legacyPinningOf(tls: z.infer<typeof tlsSection>): { ok: true; value: LegacyPinning | undefined } | Fail {
  const list = z.array(z.string().regex(VISIBLE_TEXT)).max(32);
  const fields: [name: keyof LegacyPinning, raw: unknown, detail: string][] = [
    ["pinnedPeerCertificateChainSha256", tls.pinnedPeerCertificateChainSha256, "pcs"],
    ["pinnedPeerCertificatePublicKeySha256", tls.pinnedPeerCertificatePublicKeySha256, "pcs"],
    ["verifyPeerCertInNames", tls.verifyPeerCertInNames, "vcn"],
  ];
  const value: LegacyPinning = {};
  for (const [name, raw, detail] of fields) {
    if (!isSet(raw)) continue;
    const parsed = list.safeParse(raw);
    if (!parsed.success) return fail("malformed", detail);
    value[name] = parsed.data;
  }
  return { ok: true, value: Object.keys(value).length === 0 ? undefined : value };
}

/** Строка поля TLS или REALITY: «не задано» в JSON — пусто, пустой список и `false` тоже. */
const textOf = (raw: unknown, detail: string, pattern?: RegExp): Checked => checkedText(isSet(raw) ? raw : undefined, detail, pattern);

const ECH_FORCE_QUERY = ["none", "half", "full"] as const;

function securityOf(kind: string, stream: z.infer<typeof streamSection>, host: string): { ok: true; security: NodeSecurity } | Fail {
  if (kind === "" || kind === "none") return { ok: true, security: { kind: "none" } };

  if (kind === "tls") {
    const tls = section(tlsSection, stream.tlsSettings);
    if (tls === null) return fail("malformed", "tlsSettings");
    if (isOn(tls.allowInsecure)) return fail("unsupported_option", "allowInsecure");
    const ech = textOf(tls.echConfigList, "ech");
    if (!ech.ok) return ech;
    const forceQuery = ECH_FORCE_QUERY.find((value) => value === tls.echForceQuery);
    if (isSet(tls.echForceQuery) && forceQuery === undefined) return fail("malformed", "ech");
    const pin = textOf(tls.pinnedPeerCertSha256, "pcs", PIN_SHA256);
    if (!pin.ok) return pin;
    const byName = textOf(tls.verifyPeerCertByName, "vcn");
    if (!byName.ok) return byName;
    const legacy = legacyPinningOf(tls);
    if (!legacy.ok) return legacy;
    return {
      ok: true,
      security: {
        kind: "tls",
        serverName: tls.serverName === undefined || tls.serverName === "" ? host : tls.serverName,
        alpn: tls.alpn ?? [],
        fingerprint: tls.fingerprint === undefined || tls.fingerprint === "" ? null : tls.fingerprint,
        ...optional("ech", ech.value),
        ...optional("echForceQuery", forceQuery),
        ...optional("pinnedPeerCertSha256", pin.value),
        ...optional("verifyPeerCertByName", byName.value),
        ...optional("legacyPinning", legacy.value),
      },
    };
  }

  if (kind === "reality") {
    const reality = section(realitySection, stream.realitySettings);
    if (reality === null) return fail("malformed", "realitySettings");
    const postQuantum = textOf(reality.mldsa65Verify, "pqv", BASE64URL_TEXT);
    if (!postQuantum.ok) return postQuantum;
    if (reality.publicKey === undefined || reality.publicKey === "") return fail("malformed", "publicKey");
    return {
      ok: true,
      security: {
        kind: "reality",
        serverName: reality.serverName === undefined || reality.serverName === "" ? host : reality.serverName,
        fingerprint: reality.fingerprint === undefined || reality.fingerprint === "" ? "chrome" : reality.fingerprint,
        publicKey: reality.publicKey,
        shortId: reality.shortId ?? "",
        spiderX: reality.spiderX ?? "",
        ...optional("mldsa65Verify", postQuantum.value),
      },
    };
  }
  return fail("unsupported_option", "security");
}
