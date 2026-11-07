import { lookup as systemLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Внутренние адреса (tasks/T-0070, docs/15-engineering-standards.md §7): постбэк уходит на адрес, который
 * вводят люди, и по нему нельзя достать до сети сервера — ни прямым IP, ни именем, которое во внутренний IP
 * разрешается. Проверка стоит дважды: при сохранении (`templateProblems` — по имени) и при каждой отправке
 * (`checkHost` — ещё и по тому, во что имя разрешилось). Закрепление проверенного IP на время соединения — дело
 * общего клиента исходящих запросов; здесь проверка до отправки.
 *
 * Всё неразобранное считается внутренним: отказ по умолчанию безопаснее пропуска.
 */

/** Сколько ждём ответа на поиск имени; позже — отказ с повтором: DNS мог сбойнуть. */
export const HOST_LOOKUP_TIMEOUT_MS = 3_000;

const INTERNAL_MESSAGE = "Адрес указывает на внутреннюю сеть";

/** IPv4 строго «a.b.c.d» без нулей впереди: записи с ними читаются то как десятичные, то как восьмеричные. */
function parseIPv4(text: string): [number, number, number, number] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  const [a, b, c, d] = octets;
  return a === undefined || b === undefined || c === undefined || d === undefined ? null : [a, b, c, d];
}

function isInternalIPv4([a, b, c]: readonly [number, number, number, number]): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  // Многоадресные, зарезервированные и широковещательный: 224.0.0.0–255.255.255.255.
  if (a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192) {
    if (b === 168) return true;
    // 192.0.0.0/24 — служебные, 192.0.2.0/24 — документация, 192.88.99.0/24 — устаревший ретранслятор 6to4.
    if (b === 0 && (c === 0 || c === 2)) return true;
    if (b === 88 && c === 99) return true;
  }
  // 198.18.0.0/15 — тестирование каналов, 198.51.100.0/24 и 203.0.113.0/24 — документация.
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

/** Восемь групп IPv6 или `null`; запись с вложенным IPv4 разворачивается в две группы. */
function expandIPv6(ip: string): number[] | null {
  let text = ip;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${(v4[0] * 256 + v4[1]).toString(16)}:${(v4[2] * 256 + v4[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === undefined || halves[0] === "" ? [] : halves[0].split(":");
  const rest = halves[1] === undefined || halves[1] === "" ? [] : halves[1].split(":");
  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array.from({ length: missing }, () => "0"), ...rest];
  }
  const numbers: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    numbers.push(Number.parseInt(group, 16));
  }
  return numbers.length === 8 ? numbers : null;
}

function embeddedIPv4(high: number, low: number): [number, number, number, number] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isInternalIPv6(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  // IPv4 внутри IPv6 проверяется по вложенному адресу: v4-mapped, NAT64 и 6to4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return isInternalIPv4(embeddedIPv4(g6, g7));
  // ::/96 — неуказанный, петля и устаревший «совместимый с IPv4» вид.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true;
  if (g0 === 0x64 && g1 === 0xff9b) {
    // 64:ff9b::/96 — NAT64, адрес вложен; 64:ff9b:1::/48 — для локального использования.
    if (g2 === 1) return true;
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isInternalIPv4(embeddedIPv4(g6, g7));
  }
  if (g0 === 0x2002) return isInternalIPv4(embeddedIPv4(g1, g2));
  if (g0 === 0x2001) {
    // Teredo (2001::/32), документация (2001:db8::/32), тестирование каналов (2001:2::/48).
    if (g1 === 0 || g1 === 0xdb8 || (g1 === 2 && g2 === 0)) return true;
  }
  // 100::/64 — адреса для отбрасывания.
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 — уникальные локальные
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 — link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 — site-local, устарел
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 — многоадресные
  return false;
}

/**
 * IPv4 и IPv6 из внутренних диапазонов: частные, петля, link-local, CGNAT, документация, многоадресные,
 * зарезервированные и IPv4 внутри IPv6. Адрес, который не разобрать, — внутренний.
 */
export function isInternalAddress(ip: string): boolean {
  let text = ip.trim();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  // Зона нужна только link-local адресам: во внешний мир с ней не ходят.
  if (text.includes("%")) return true;
  const v4 = parseIPv4(text);
  if (v4 !== null) return isInternalIPv4(v4);
  if (isIP(text) === 6) {
    const groups = expandIPv6(text);
    return groups === null ? true : isInternalIPv6(groups);
  }
  return true;
}

/** Суффиксы, которые внутренние по смыслу: имя с таким окончанием не из публичного интернета. */
const INTERNAL_SUFFIXES = ["localhost", "local", "internal", "lan", "home.arpa"] as const;

/** Последняя часть имени — число или «0x…»: такое имя разбирается как IPv4 (`2130706433`, `127.1`, `0x7f000001`). */
function isNumericHost(host: string): boolean {
  const last = host.split(".").at(-1) ?? "";
  return /^(0x[0-9a-f]*|[0-9]+)$/i.test(last);
}

/**
 * Имя сайта, внутреннее само по себе: `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.lan`,
 * `*.home.arpa`, имя без точки и IP-литерал внутреннего диапазона. Числовые записи IPv4 читаются так же,
 * как их прочитает браузер.
 */
export function isInternalHostname(host: string): boolean {
  let name = host.trim().toLowerCase();
  if (name.startsWith("[") && name.endsWith("]")) name = name.slice(1, -1);
  if (name.endsWith(".")) name = name.slice(0, -1);
  if (name === "") return true;
  if (isIP(name) !== 0) return isInternalAddress(name);
  if (isNumericHost(name)) {
    try {
      const normalized = new URL(`https://${name}/`).hostname;
      return isIP(normalized) === 4 ? isInternalAddress(normalized) : true;
    } catch {
      return true;
    }
  }
  if (!name.includes(".")) return true;
  return INTERNAL_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

export type HostCheck = { ok: true } | { ok: false; message: string; retry: boolean };

async function resolveAll(host: string): Promise<readonly string[]> {
  const answers = await systemLookup(host, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

/** Ответ, который не пришёл за срок, — исключение; таймер снимается в любом исходе. */
async function withinDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("lookup timeout")), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Разрешить имя (срок — `HOST_LOOKUP_TIMEOUT_MS`) и проверить каждый ответ: хоть один внутренний — отказ без
 * повтора, имя не разрешилось, ответ пуст или не пришёл за срок — отказ с повтором. IP-литерал и внутреннее
 * имя отказывают сразу, без поиска. Тексты не содержат запроса адреса.
 */
export async function checkHost(host: string, lookup: (host: string) => Promise<readonly string[]> = resolveAll): Promise<HostCheck> {
  let name = host.trim().toLowerCase();
  if (name.startsWith("[") && name.endsWith("]")) name = name.slice(1, -1);
  if (name.endsWith(".")) name = name.slice(0, -1);
  if (isInternalHostname(name)) return { ok: false, message: INTERNAL_MESSAGE, retry: false };
  if (isIP(name) !== 0) return { ok: true };

  let addresses: readonly string[];
  try {
    addresses = await withinDeadline(lookup(name), HOST_LOOKUP_TIMEOUT_MS);
  } catch (error: unknown) {
    const timedOut = error instanceof Error && error.message === "lookup timeout";
    return { ok: false, message: timedOut ? "Имя сайта не ответило за 3 секунды" : "Имя сайта не разрешилось", retry: true };
  }
  if (addresses.length === 0) return { ok: false, message: "Имя сайта не разрешилось", retry: true };
  if (addresses.some((address) => isInternalAddress(address))) return { ok: false, message: "Имя сайта указывает на внутреннюю сеть", retry: false };
  return { ok: true };
}
