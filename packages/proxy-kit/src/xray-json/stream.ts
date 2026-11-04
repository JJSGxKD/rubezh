import { z } from "zod";
import type { NodeSecurity, NodeTransport } from "../node.js";
import { fail, networkOf, type Fail } from "../links/common.js";

/**
 * `streamSettings` выхода Xray в транспорт и безопасность узла — то же, что
 * `streamFromParams` делает с параметрами ссылки, и с теми же отказами: чего
 * не умеем, пропускается, а не угадывается. Имена полей — как в конфиге Xray
 * (обратное преобразование — `xray-config.ts`); `detail` отказа — тоже имя поля
 * либо то короткое имя, которым его называют ссылки (`pcs`, `ech`, `pqv`).
 */

export type StreamResult = { ok: true; transport: NodeTransport; security: NodeSecurity } | Fail;

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
});

const realitySection = z.object({ serverName: text, fingerprint: text, publicKey: text, shortId: text, spiderX: text, mldsa65Verify: z.unknown().optional() });
const tcpSection = z.object({ header: z.object({ type: text }).optional() });
const wsSection = z.object({ path: text, host: text, headers: z.record(z.string(), z.unknown()).optional() });
const pathSection = z.object({ path: text, host: text, mode: text });
const grpcSection = z.object({ serviceName: text, multiMode: z.boolean().optional() });
const sockoptSection = z.object({ dialerProxy: z.unknown().optional() });

/** Есть ли в поле что-то, кроме «не задано»: пустая строка, пустой список и `false` — нет. */
const isSet = (value: unknown): boolean => value !== undefined && value !== null && value !== "" && value !== false && !(Array.isArray(value) && value.length === 0);

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
  // Цепочка через другой выход: без него узел пойдёт напрямую, а это другой маршрут.
  if (isSet(sockopt.dialerProxy)) return fail("unsupported_option", "dialerProxy");

  const network = networkOf(stream.network === undefined || stream.network === "" ? "tcp" : stream.network);
  if (network === null) return fail("unsupported_transport", "network");

  const transport: NodeTransport = { network };
  const failure = fillTransport(transport, stream);
  if (failure !== null) return failure;

  const security = securityOf(stream.security ?? "", stream, host);
  return security.ok ? { ok: true, transport, security: security.security } : security;
}

/** Параметры транспорта по сети; `null` — всё в порядке. */
function fillTransport(transport: NodeTransport, stream: z.infer<typeof streamSection>): Fail | null {
  const present = (value: string | undefined): string | undefined => (value === undefined || value === "" ? undefined : value);

  switch (transport.network) {
    case "tcp": {
      const tcp = section(tcpSection, stream.tcpSettings ?? stream.rawSettings);
      if (tcp === null) return fail("malformed", "tcpSettings");
      const kind = tcp.header?.type ?? "";
      return kind === "" || kind === "none" ? null : fail("unsupported_option", "headerType");
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
    case "httpupgrade":
    case "xhttp": {
      const key = transport.network === "xhttp" ? stream.xhttpSettings : stream.httpupgradeSettings;
      const settings = section(pathSection, key);
      if (settings === null) return fail("malformed", transport.network === "xhttp" ? "xhttpSettings" : "httpupgradeSettings");
      const path = present(settings.path);
      const host = present(settings.host);
      const mode = transport.network === "xhttp" ? present(settings.mode) : undefined;
      if (path !== undefined) transport.path = path;
      if (host !== undefined) transport.host = host;
      if (mode !== undefined) transport.mode = mode;
      return null;
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

function securityOf(kind: string, stream: z.infer<typeof streamSection>, host: string): { ok: true; security: NodeSecurity } | Fail {
  if (kind === "" || kind === "none") return { ok: true, security: { kind: "none" } };

  if (kind === "tls") {
    const tls = section(tlsSection, stream.tlsSettings);
    if (tls === null) return fail("malformed", "tlsSettings");
    if (isOn(tls.allowInsecure)) return fail("unsupported_option", "allowInsecure");
    if (isSet(tls.pinnedPeerCertificateChainSha256) || isSet(tls.pinnedPeerCertSha256) || isSet(tls.pinnedPeerCertificatePublicKeySha256)) return fail("unsupported_option", "pcs");
    if (isSet(tls.verifyPeerCertByName) || isSet(tls.verifyPeerCertInNames)) return fail("unsupported_option", "vcn");
    if (isSet(tls.echConfigList)) return fail("unsupported_option", "ech");
    return {
      ok: true,
      security: { kind: "tls", serverName: tls.serverName === undefined || tls.serverName === "" ? host : tls.serverName, alpn: tls.alpn ?? [], fingerprint: tls.fingerprint === undefined || tls.fingerprint === "" ? null : tls.fingerprint },
    };
  }

  if (kind === "reality") {
    const reality = section(realitySection, stream.realitySettings);
    if (reality === null) return fail("malformed", "realitySettings");
    if (isSet(reality.mldsa65Verify)) return fail("unsupported_option", "pqv");
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
      },
    };
  }
  return fail("unsupported_option", "security");
}
