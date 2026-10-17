import { decodeBase64 } from "../internal/base64.js";
import { bareHost, cleanName, parsePort, safeDecode } from "../internal/text.js";
import type { ShareLinkResult } from "../node.js";
import { fail, finishNode } from "./common.js";

/** Шифры Xray; ключ — как называют в ссылках, значение — имя в конфиге. */
const METHODS: ReadonlyMap<string, string> = new Map([
  ["aes-128-gcm", "aes-128-gcm"],
  ["aes-256-gcm", "aes-256-gcm"],
  ["chacha20-poly1305", "chacha20-poly1305"],
  ["chacha20-ietf-poly1305", "chacha20-poly1305"],
  ["xchacha20-poly1305", "xchacha20-poly1305"],
  ["xchacha20-ietf-poly1305", "xchacha20-poly1305"],
  ["2022-blake3-aes-128-gcm", "2022-blake3-aes-128-gcm"],
  ["2022-blake3-aes-256-gcm", "2022-blake3-aes-256-gcm"],
  ["2022-blake3-chacha20-poly1305", "2022-blake3-chacha20-poly1305"],
]);

const HOST_PORT = /^(\[[^\]]+\]|[^:[\]]+):(\d+)$/;

/**
 * `ss://` в трёх видах: SIP002 с base64url-userinfo, SIP002 для 2022-шифров
 * (`метод:пароль` в процентной кодировке) и старая base64 от всей
 * `метод:пароль@host:port`.
 */
export function parseShadowsocks(link: string): ShareLinkResult {
  const withoutScheme = link.replace(/^ss:\/\//i, "");
  const hashAt = withoutScheme.indexOf("#");
  const fragment = hashAt === -1 ? "" : withoutScheme.slice(hashAt + 1);
  const beforeFragment = hashAt === -1 ? withoutScheme : withoutScheme.slice(0, hashAt);
  const queryAt = beforeFragment.indexOf("?");
  const query = new URLSearchParams(queryAt === -1 ? "" : beforeFragment.slice(queryAt + 1));
  const main = (queryAt === -1 ? beforeFragment : beforeFragment.slice(0, queryAt)).replace(/\/+$/, "");

  let userinfo: string;
  let hostPort: string;
  const at = main.lastIndexOf("@");
  if (at === -1) {
    // Старая форма: внутри base64 лежит и пароль, и адрес.
    const decoded = decodeBase64(main);
    const innerAt = decoded?.lastIndexOf("@") ?? -1;
    if (decoded === null || innerAt === -1) return fail("malformed", "base64");
    userinfo = decoded.slice(0, innerAt);
    hostPort = decoded.slice(innerAt + 1);
  } else {
    hostPort = main.slice(at + 1);
    const raw = main.slice(0, at);
    // С двоеточием — 2022-форма в процентной кодировке; без него — base64.
    const decoded = raw.includes(":") ? safeDecode(raw) : decodeBase64(raw);
    if (decoded === null) return fail("malformed", "userinfo");
    userinfo = decoded;
  }

  const split = userinfo.indexOf(":");
  if (split <= 0) return fail("malformed", "userinfo");
  const method = userinfo.slice(0, split);
  const secret = userinfo.slice(split + 1);
  if (secret === "") return fail("malformed", "password");

  const match = HOST_PORT.exec(hostPort);
  const port = parsePort(match?.[2] ?? "");
  const host = bareHost(match?.[1] ?? "");
  if (host === "" || port === null) return fail("malformed", "port");

  if (query.has("plugin")) return fail("unsupported_option", "plugin");
  const cipher = METHODS.get(method.toLowerCase());
  if (cipher === undefined) return fail("unsupported_cipher", "method");

  return {
    ok: true,
    node: finishNode({ protocol: "shadowsocks", name: cleanName(fragment, `${host}:${port}`), host, port, secret, flow: null, cipher, transport: { network: "tcp" }, security: { kind: "none" } }),
  };
}
