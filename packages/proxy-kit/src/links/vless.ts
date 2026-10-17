import type { ShareLinkResult } from "../node.js";
import { fail, finishNode, streamFromParams, UUID } from "./common.js";
import { isFail, parseUri } from "./uri.js";

/** `vless://uuid@host:port?type=…&security=…#название`. */
export function parseVless(link: string): ShareLinkResult {
  const uri = parseUri(link);
  if (isFail(uri)) return uri;
  if (!UUID.test(uri.username)) return fail("malformed", "uuid");

  // Шифрование VLESS в обычных подписках — `none`; постквантовое и прочее
  // мы не собираем, а пропускаем.
  const encryption = uri.params.get("encryption") ?? "none";
  if (encryption !== "none" && encryption !== "") return fail("unsupported_option", "encryption");
  const flow = uri.params.get("flow") ?? "";
  if (flow !== "" && flow !== "xtls-rprx-vision") return fail("unsupported_option", "flow");

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
      cipher: null,
      transport: stream.transport,
      security: stream.security,
    }),
  };
}
