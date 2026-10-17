/**
 * Защита от SSRF: адрес подписки задаёт человек, а запрос идёт из сети
 * сервера. Только `https`, без логина и пароля, а имя и IP — публичные.
 *
 * Имя, которое снаружи выглядит публичным, может указывать на закрытый адрес;
 * это проверяет `assertAllowed` загрузчика (резолв имени и сверка с
 * `isPublicAddress`) — пакет сам в DNS не ходит.
 */
export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: "malformed" | "scheme" | "credentials" | "host" };

/** Суффиксы имён, которые живут только во внутренних сетях. */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan"];

export function checkSubscriptionUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials" };
  return isAllowedHost(url.hostname) ? { ok: true, url } : { ok: false, reason: "host" };
}

function isAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "") return false;
  // URL уже привёл десятичную и шестнадцатеричную запись IP к виду 127.0.0.1.
  if (host.startsWith("[")) return isPublicAddress(host.slice(1, -1));
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPublicAddress(host);
  if (host === "localhost" || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  // Одна метка без точки — имя сервиса в сети compose (`redis`, `postgres`).
  return host.includes(".");
}

/** IP из публичного пространства: не частный, не служебный, не документационный. */
export function isPublicAddress(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4 !== null) return isPublicIpv4(v4);
  const v6 = parseIpv6(ip);
  return v6 === null ? false : isPublicIpv6(v6);
}

function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

/** [от, до] включительно, в виде числа из 32 бит. */
const PRIVATE_V4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function toNumber(octets: readonly number[]): number {
  return ((octets[0] ?? 0) * 2 ** 24 + (octets[1] ?? 0) * 2 ** 16 + (octets[2] ?? 0) * 2 ** 8 + (octets[3] ?? 0)) >>> 0;
}

function isPublicIpv4(octets: readonly number[]): boolean {
  const value = toNumber(octets);
  return !PRIVATE_V4.some(([base, bits]) => {
    const baseValue = toNumber(parseIpv4(base) ?? [0, 0, 0, 0]);
    const size = 2 ** (32 - bits);
    return value >= baseValue && value < baseValue + size;
  });
}

/** Восемь 16-битных групп; `null` — не IPv6. */
function parseIpv6(text: string): number[] | null {
  if (text.includes("%") || !/^[0-9a-fA-F:.]+$/.test(text)) return null;
  let source = text;
  const tail = source.slice(source.lastIndexOf(":") + 1);
  if (tail.includes(".")) {
    const embedded = parseIpv4(tail);
    if (embedded === null) return null;
    const high = ((embedded[0] ?? 0) << 8) | (embedded[1] ?? 0);
    const low = ((embedded[2] ?? 0) << 8) | (embedded[3] ?? 0);
    source = `${source.slice(0, source.lastIndexOf(":") + 1)}${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":").map((group) => (/^[0-9a-fA-F]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
    return groups.some(Number.isNaN) ? null : groups;
  };
  const head = toGroups(halves[0] ?? "");
  const rest = toGroups(halves[1] ?? "");
  if (head === null || rest === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const zeros = 8 - head.length - rest.length;
  return zeros < 1 ? null : [...head, ...new Array<number>(zeros).fill(0), ...rest];
}

function isPublicIpv6(groups: readonly number[]): boolean {
  const g = (index: number): number => groups[index] ?? 0;
  const embedded = (high: number, low: number): number[] => [high >> 8, high & 0xff, low >> 8, low & 0xff];
  const firstFiveZero = groups.slice(0, 5).every((group) => group === 0);

  if (groups.every((group) => group === 0)) return false; // ::
  if (firstFiveZero && g(5) === 0xffff) return isPublicIpv4(embedded(g(6), g(7))); // ::ffff:a.b.c.d
  if (firstFiveZero && g(5) === 0) return g(6) === 0 && g(7) === 1 ? false : isPublicIpv4(embedded(g(6), g(7))); // ::1 и ::a.b.c.d
  if (g(0) === 0x64 && g(1) === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) return isPublicIpv4(embedded(g(6), g(7))); // NAT64
  if ((g(0) & 0xfe00) === 0xfc00) return false; // fc00::/7
  if ((g(0) & 0xffc0) === 0xfe80) return false; // fe80::/10
  if ((g(0) & 0xffc0) === 0xfec0) return false; // fec0::/10, устаревший site-local
  if ((g(0) & 0xff00) === 0xff00) return false; // ff00::/8
  if (g(0) === 0x2001 && g(1) === 0x0db8) return false; // документация
  return true;
}
