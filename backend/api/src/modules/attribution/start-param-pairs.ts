/**
 * Параметр запуска из пар «ключ-значение»: `src-tgads_cmp-oct` (Р116,
 * docs/24-attribution-and-sharing.md §3.6). Чистые функции — без Nest и базы.
 *
 * Пары разделены `_`, ключ от значения — `-`. Оба знака разрешены в параметре Telegram
 * (`A-Za-z0-9_-`, до 64 знаков), поэтому внутри значения их быть не может: значение — только
 * латиница и цифры. Однобуквенные приставки (`c-`, `l-`, `f-`, `n-`) заняты другими видами
 * ссылок, поэтому ключ не короче двух знаков; `panel` и `role` — вход в панель и подтверждение
 * роли в боте, пары автоисточника из них не бывает.
 *
 * Ключи — закрытый список. Новый ключ — строка в `AUTO_KEYS`, поле в `PairsResult.known` и запись
 * в §3.6 документа атрибуции; незнакомый ключ источником не становится, а копится сводкой.
 */

/** Известные ключи в каноническом порядке: по нему собирается ключ источника. */
export const AUTO_KEYS = ["src", "cmp", "plc", "prt"] as const;
export type AutoKey = (typeof AUTO_KEYS)[number];

/** Зарезервированы: `PANEL_LOGIN_PREFIX` и `ROLE_CONFIRM_PREFIX` — это не пары автоисточника. */
export const RESERVED_KEYS = ["panel", "role"] as const;

/** Частей в параметре не больше: известные ключи и запас на незнакомые. */
const MAX_PARTS = 6;
const PAIR = /^([A-Za-z][A-Za-z0-9]{1,15})-([A-Za-z0-9]{1,24})$/;

export interface PairsResult {
  /** известные пары: ключ и значение в нижнем регистре */
  known: Partial<Record<AutoKey, string>>;
  /** известные пары в порядке `AUTO_KEYS` через `_`; `null` — известных нет */
  canonical: string | null;
  /** незнакомые ключи по алфавиту, без значений */
  unknownKeys: string[];
}

function isAutoKey(key: string): key is AutoKey {
  return (AUTO_KEYS as readonly string[]).includes(key);
}

function isReservedKey(key: string): boolean {
  return (RESERVED_KEYS as readonly string[]).includes(key);
}

/**
 * Разобрать значение как пары. `null` — это не формат пар: пустая часть, повтор ключа,
 * зарезервированный ключ, слишком много частей или часть не по шаблону. Регистр не важен.
 */
export function parsePairs(value: string): PairsResult | null {
  const parts = value.split("_");
  if (parts.length > MAX_PARTS) return null;

  const known: Partial<Record<AutoKey, string>> = {};
  const unknown = new Set<string>();
  const seen = new Set<string>();
  for (const part of parts) {
    const match = PAIR.exec(part);
    if (match === null) return null;
    const key = (match[1] ?? "").toLowerCase();
    const pairValue = (match[2] ?? "").toLowerCase();
    if (isReservedKey(key) || seen.has(key)) return null;
    seen.add(key);
    if (isAutoKey(key)) known[key] = pairValue;
    else unknown.add(key);
  }

  const canonicalParts: string[] = [];
  for (const key of AUTO_KEYS) {
    const pairValue = known[key];
    if (pairValue !== undefined) canonicalParts.push(`${key}-${pairValue}`);
  }
  return { known, canonical: canonicalParts.length === 0 ? null : canonicalParts.join("_"), unknownKeys: [...unknown].sort() };
}
