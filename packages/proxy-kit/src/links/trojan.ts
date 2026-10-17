import type { ShareLinkResult } from "../node.js";
import { fail, finishNode, streamFromParams } from "./common.js";
import { isFail, parseUri } from "./uri.js";

/** `trojan://пароль@host:port?…#название`; без `security` подразумевается tls. */
export function parseTrojan(link: string): ShareLinkResult {
  const uri = parseUri(link);
  if (isFail(uri)) return uri;
  // Пароль — всё userinfo: двоеточие в нём допустимо.
  const secret = uri.password === "" ? uri.username : `${uri.username}:${uri.password}`;
  if (secret === "") return fail("malformed", "password");

  const stream = streamFromParams(uri.params, uri.host, "tls");
  if (!stream.ok) return stream;
  return {
    ok: true,
    node: finishNode({ protocol: "trojan", name: uri.name, host: uri.host, port: uri.port, secret, flow: null, cipher: null, transport: stream.transport, security: stream.security }),
  };
}
