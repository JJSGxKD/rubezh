/** Пределы объекта, который приходит от поставщика подписки и уходит в конфиг Xray как есть. */
export interface JsonLimits {
  /** длина сериализованного JSON, знаков */
  maxChars: number;
  /** глубина вложенности: у `{}` она 1, у `{ a: {} }` — 2 */
  maxDepth: number;
}

/** Предел для `extra`, заголовка RAW и настроек служебного `freedom`. */
export const OBJECT_LIMITS: JsonLimits = { maxChars: 4096, maxDepth: 8 };

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function depthOf(value: unknown, limit: number, depth = 1): number {
  if (depth > limit) return depth;
  let deepest = depth;
  const children = Array.isArray(value) ? value : isPlainObject(value) ? Object.values(value) : [];
  for (const child of children) {
    if (typeof child === "object" && child !== null) deepest = Math.max(deepest, depthOf(child, limit, depth + 1));
    if (deepest > limit) break;
  }
  return deepest;
}

/**
 * Объект как есть, но без чужих хвостов: копия через JSON, а не сама ссылка.
 * `null` — не объект (список, строка, число), длиннее `maxChars` знаков в
 * сериализованном виде или глубже `maxDepth` уровней. Данные приходят из сети,
 * поэтому предел стоит до того, как объект попадёт в узел.
 */
export function jsonObjectOf(value: unknown, limits: JsonLimits = OBJECT_LIMITS): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  if (depthOf(value, limits.maxDepth) > limits.maxDepth) return null;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (text.length > limits.maxChars) return null;
  const copy: unknown = JSON.parse(text);
  return isPlainObject(copy) ? copy : null;
}

/** Тот же JSON с ключами по порядку на всех уровнях: порядок в источнике на ключ узла не влияет. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sorted(value));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  return value;
}
