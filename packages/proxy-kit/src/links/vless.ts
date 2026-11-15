import type { ShareLinkResult } from "../node.js";
import { fail, finishNode, streamFromParams, UUID, VLESS_FLOWS, vlessEncryption } from "./common.js";
import { isFail, parseUri } from "./uri.js";

/** `vless://uuid@host:port?type=…&security=…#название`. */
export function parseVless(link: string): ShareLinkResult {
  const uri = parseUri(link);
  if (isFail(uri)) return uri;
  if (!UUID.test(uri.username)) return fail("malformed", "uuid");

  // Шифрование VLESS: `none` — без него, постквантовая строка уходит в узел как есть.
  const encryption = vlessEncryption(uri.params.get("encryption") ?? undefined);
  if (!encryption.ok) return encryption;
  const flow = uri.params.get("flow") ?? "";
  if (flow !== "" && !VLESS_FLOWS.has(flow)) return fail("unsupported_option", "flow");

  const stream = streamFromParams(uri.params, uri.host, "none");
  if (!stream.ok) return stream;
  return {
    ok: true,
    node: finishNode({
      protocol: "vless",
      name: uri.name,
      host: uri.host,
      port: uri.port,
      secret: uri.username.toLowerCase(),
      flow: flow === "" ? null : flow,
      cipher: encryption.cipher,
      transport: stream.transport,
      security: stream.security,
    }),
  };
}
