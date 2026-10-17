import type { ShareLinkResult } from "./node.js";
import { fail } from "./links/common.js";
import { parseShadowsocks } from "./links/shadowsocks.js";
import { parseTrojan } from "./links/trojan.js";
import { parseVless } from "./links/vless.js";
import { parseVmess } from "./links/vmess.js";

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;

/**
 * Одна ссылка узла в `ProxyNode`. Не бросает: ссылка — вход из сети, и плохая
 * не должна ронять разбор остальных. Отказ несёт причину и подробность
 * (`detail`) — имя параметра или схему, но никогда не кусок ссылки.
 */
export function parseShareLink(link: string): ShareLinkResult {
  const scheme = SCHEME.exec(link.trim())?.[1]?.toLowerCase();
  if (scheme === undefined) return fail("malformed", "scheme");
  const trimmed = link.trim();
  try {
    switch (scheme) {
      case "vless":
        return parseVless(trimmed);
      case "vmess":
        return parseVmess(trimmed);
      case "trojan":
        return parseTrojan(trimmed);
      case "ss":
        return parseShadowsocks(trimmed);
      default:
        return fail("unsupported_scheme", scheme);
    }
  } catch {
    // Разбор не должен падать, но если упал — это «ссылка непонятна», а не авария.
    return fail("malformed", scheme);
  }
}
