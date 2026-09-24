import { isIPv4, isIPv6 } from "node:net";

/**
 * Подсеть вместо адреса (docs/24-attribution-and-sharing.md §6). Адрес
 * целиком — персональные данные, а для антифрода вроде «много запусков из
 * одной подсети» и грубого гео хватает префикса: /24 у IPv4, /48 у IPv6 —
 * это провайдер или офис, а не человек.
 */
export function ipPrefix(address: string | null): string | null {
  if (address === null || address === "") return null;
  // IPv4 в обёртке IPv6 — так его отдаёт сервер, слушающий оба протокола.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  const ip = mapped?.[1] ?? address;

  if (isIPv4(ip)) {
    const [a, b, c] = ip.split(".");
    return `${a}.${b}.${c}.0/24`;
  }
  if (isIPv6(ip)) {
    const groups = expandIPv6(ip);
    return groups === null ? null : `${groups.slice(0, 3).join(":")}::/48`;
  }
  return null;
}

/** Восемь групп IPv6 без сокращений; `null` — адрес с IPv4 в хвосте, который здесь не нужен. */
function expandIPv6(ip: string): string[] | null {
  const address = ip.split("%")[0] ?? ip;
  if (address.includes(".")) return null;
  const [head = "", tail] = address.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = 8 - left.length - right.length;
  if (tail === undefined && left.length !== 8) return null;
  const groups = [...left, ...Array.from({ length: Math.max(missing, 0) }, () => "0"), ...right];
  return groups.map((group) => (group.replace(/^0+(?=.)/, "") || "0").toLowerCase());
}
