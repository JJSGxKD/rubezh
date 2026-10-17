/** Предел названия узла, знаков. */
const NAME_LIMIT = 80;

/** `decodeURIComponent`, не падающий на битой кодировке: тогда строка как есть. */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Название из фрагмента ссылки: декодировано, без управляющих символов, не длиннее 80 знаков. */
export function cleanName(fragment: string, fallback: string): string {
  const decoded = safeDecode(fragment.replace(/^#/, ""));
  const cleaned = decoded.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  const name = [...cleaned].slice(0, NAME_LIMIT).join("");
  return name === "" ? fallback : name;
}

/** Хост без квадратных скобок IPv6. */
export function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** Порт 1…65535 из строки; `null` — не порт. */
export function parsePort(value: string): number | null {
  if (!/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}
