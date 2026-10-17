import { z } from "zod";
import { decodeBase64 } from "../internal/base64.js";
import { cleanName, parsePort } from "../internal/text.js";
import type { NodeSecurity, NodeTransport, ShareLinkResult } from "../node.js";
import { fail, finishNode, listOf, networkOf, streamFromParams, UUID } from "./common.js";
import { isFail, parseUri } from "./uri.js";

/** Шифры VMess, которые собирает Xray из ссылки. */
const CIPHERS: ReadonlySet<string> = new Set(["auto", "aes-128-gcm", "chacha20-poly1305", "none"]);

/** Поле JSON-формы приходит то строкой, то числом, то отсутствует. */
const loose = z.union([z.string(), z.number(), z.boolean()]).optional();

const vmessJson = z.object({
  add: z.string().min(1),
  port: z.union([z.string(), z.number()]),
  id: z.string(),
  aid: loose,
  scy: loose,
  net: loose,
  type: loose,
  host: loose,
  path: loose,
  tls: loose,
  sni: loose,
  alpn: loose,
  fp: loose,
  ps: loose,
  allowInsecure: loose,
});

const text = (value: string | number | boolean | undefined): string => (value === undefined ? "" : String(value));

/**
 * `vmess://` в двух видах: адресная форма `vmess://uuid@host:port?…` (параметры
 * как у vless) и привычная base64-JSON.
 */
export function parseVmess(link: string): ShareLinkResult {
  return /^vmess:\/\/[^?#]*@/i.test(link) ? parseAddressForm(link) : parseJsonForm(link);
}

function parseAddressForm(link: string): ShareLinkResult {
  const uri = parseUri(link);
  if (isFail(uri)) return uri;
  if (!UUID.test(uri.username)) return fail("malformed", "uuid");

  const cipher = uri.params.get("encryption") ?? "auto";
  if (!CIPHERS.has(cipher)) return fail("unsupported_cipher", "encryption");
  const aid = uri.params.get("aid") ?? "0";
  if (aid !== "0" && aid !== "") return fail("unsupported_option", "aid");

  const stream = streamFromParams(uri.params, uri.host, "none");
  if (!stream.ok) return stream;
  return {
    ok: true,
    node: finishNode({ protocol: "vmess", name: uri.name, host: uri.host, port: uri.port, secret: uri.username.toLowerCase(), flow: null, cipher, transport: stream.transport, security: stream.security }),
  };
}

function parseJsonForm(link: string): ShareLinkResult {
  const body = link.replace(/^vmess:\/\//i, "").split("#", 1)[0] ?? "";
  const decoded = decodeBase64(body);
  if (decoded === null) return fail("malformed", "base64");

  let raw: unknown;
  try {
    raw = JSON.parse(decoded);
  } catch {
    return fail("malformed", "json");
  }
  const parsed = vmessJson.safeParse(raw);
  if (!parsed.success) return fail("malformed", "json");
  const data = parsed.data;

  const port = parsePort(String(data.port));
  if (port === null) return fail("malformed", "port");
  if (!UUID.test(data.id)) return fail("malformed", "uuid");

  const aid = text(data.aid);
  if (aid !== "" && aid !== "0") return fail("unsupported_option", "aid");
  if (["1", "true", "yes"].includes(text(data.allowInsecure).toLowerCase())) return fail("unsupported_option", "allowInsecure");
  const cipher = text(data.scy) === "" ? "auto" : text(data.scy);
  if (!CIPHERS.has(cipher)) return fail("unsupported_cipher", "scy");

  const network = networkOf(text(data.net) === "" ? "tcp" : text(data.net));
  if (network === null) return fail("unsupported_transport", "net");
  const kind = text(data.type);
  if (network === "tcp" && kind !== "" && kind !== "none") return fail("unsupported_option", "type");

  const transport: NodeTransport = { network };
  if (network === "ws" || network === "httpupgrade" || network === "xhttp") {
    if (text(data.path) !== "") transport.path = text(data.path);
    if (text(data.host) !== "") transport.host = text(data.host);
  }
  // В JSON-форме у gRPC `path` — имя сервиса, а `type` — режим.
  if (network === "grpc" && text(data.path) !== "") transport.serviceName = text(data.path);
  if ((network === "grpc" || network === "xhttp") && kind !== "" && kind !== "none") transport.mode = kind;

  const security = securityOf(data, data.add);
  if (!security.ok) return security;
  return {
    ok: true,
    node: finishNode({
      protocol: "vmess",
      name: cleanName(text(data.ps), `${data.add}:${port}`),
      host: data.add,
      port,
      secret: data.id.toLowerCase(),
      flow: null,
      cipher,
      transport,
      security: security.security,
    }),
  };
}

function securityOf(data: z.infer<typeof vmessJson>, address: string): { ok: true; security: NodeSecurity } | ReturnType<typeof fail> {
  const tls = text(data.tls);
  if (tls === "" || tls === "none") return { ok: true, security: { kind: "none" } };
  if (tls !== "tls") return fail("unsupported_option", "tls");
  const serverName = text(data.sni) !== "" ? text(data.sni) : text(data.host) !== "" ? text(data.host) : address;
  return { ok: true, security: { kind: "tls", serverName, alpn: listOf(text(data.alpn)), fingerprint: text(data.fp) === "" ? null : text(data.fp) } };
}
