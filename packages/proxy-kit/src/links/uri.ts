import { bareHost, cleanName, parsePort, safeDecode } from "../internal/text.js";
import { fail, type Fail } from "./common.js";

export interface ParsedUri {
  username: string;
  password: string;
  host: string;
  port: number;
  params: URLSearchParams;
  name: string;
}

/**
 * Ссылка вида `схема://user@host:port?query#name` через `URL`, а не
 * регулярками. Первое значение повторяющегося параметра — то, что вернёт
 * `URLSearchParams.get`.
 */
export function parseUri(link: string): ParsedUri | Fail {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return fail("malformed", "url");
  }
  const host = bareHost(url.hostname);
  const port = parsePort(url.port);
  if (host === "" || port === null) return fail("malformed", "port");
  return {
    username: safeDecode(url.username),
    password: safeDecode(url.password),
    host,
    port,
    params: url.searchParams,
    name: cleanName(url.hash, `${host}:${port}`),
  };
}

export function isFail(value: ParsedUri | Fail): value is Fail {
  return "ok" in value;
}
