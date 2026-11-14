/**
 * «Взять из кода» (docs/19-content-admin.md §4.5, tasks/T-0306): код сменил
 * контент, пока в игре стоит версия из панели, и новое понятие или поле
 * доезжает до черновика, не затирая того, что геймдизайнер уже поправил.
 *
 * Только добавление: ключи, которых в черновике нет, и элементы списков, чьего
 * `id` в нём нет. Значения, которые в черновике уже есть, не меняются — даже
 * если в коде число другое: вопрос «чьё число верное» решает человек правкой.
 */

export interface MergeResult {
  merged: unknown;
  /** сколько ключей и элементов списков дописано */
  added: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasId(value: unknown): value is Record<string, unknown> & { id: string } {
  return isObject(value) && typeof value.id === "string";
}

/** Копия значения: добавленное не должно делить ссылки с версией, из которой взято. */
function copyOf(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function mergeValue(target: unknown, source: unknown, counter: { added: number }): unknown {
  if (isObject(target) && isObject(source)) {
    // `fromEntries`, а не присваивание по ключу: ключ `__proto__` из JSON стал бы прототипом, а не полем.
    const entries = new Map<string, unknown>(Object.entries(target));
    for (const [key, value] of Object.entries(source)) {
      if (entries.has(key)) entries.set(key, mergeValue(entries.get(key), value, counter));
      else {
        entries.set(key, copyOf(value));
        counter.added += 1;
      }
    }
    return Object.fromEntries(entries);
  }
  if (Array.isArray(target) && Array.isArray(source)) {
    const byId = target.every(hasId) && source.every(hasId) && target.length + source.length > 0;
    if (byId) return mergeById(target as (Record<string, unknown> & { id: string })[], source as (Record<string, unknown> & { id: string })[], counter);
    // Без `id` элемент не назвать, а длина списка — значение: сливается то, что стоит на одних и тех же местах.
    return target.map((item, index) => (index < source.length ? mergeValue(item, source[index], counter) : item));
  }
  return target;
}

function mergeById(target: (Record<string, unknown> & { id: string })[], source: (Record<string, unknown> & { id: string })[], counter: { added: number }): unknown[] {
  const sourceById = new Map(source.map((item) => [item.id, item]));
  const merged: unknown[] = target.map((item) => {
    const counterpart = sourceById.get(item.id);
    return counterpart === undefined ? item : mergeValue(item, counterpart, counter);
  });
  const known = new Set(target.map((item) => item.id));
  for (const item of source) {
    if (known.has(item.id)) continue;
    merged.push(copyOf(item));
    counter.added += 1;
  }
  return merged;
}

/** Дописать в `target` то, чего в нём нет, из `source`; ни один из аргументов не меняется. */
export function mergeAdditions(target: unknown, source: unknown): MergeResult {
  const counter = { added: 0 };
  const merged = mergeValue(copyOf(target), source, counter);
  return { merged, added: counter.added };
}
