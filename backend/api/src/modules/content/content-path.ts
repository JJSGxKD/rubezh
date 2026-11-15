import { ContentPathError } from "./content-errors.js";

/**
 * Путь правки в снимке: `enemies[id=swarm_rat].hp`, `timeline[3].spawns[0].perSec`
 * (docs/19-content-admin.md §3, tasks/T-0303).
 *
 * Грамматика: ключ, затем сколько угодно скобок — `[3]` берёт элемент списка по
 * индексу, `[id=swarm_rat]` — по значению поля; дальше `.ключ` и так до конца.
 * Корень снимка — объект, поэтому путь начинается с ключа. Кавычек и экранирования
 * нет сознательно: в снимке ключи — идентификаторы, а значения `id` — слаги.
 */

export type PathSegment = { kind: "key"; name: string } | { kind: "index"; index: number } | { kind: "find"; field: string; value: string };

/** Укладывается в идентификатор: путь, не ведущий в `__proto__`, остаётся данными. */
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEY_CHARS = /[A-Za-z0-9_]/;
const INDEX = /^\d{1,6}$/;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export const PATH_MAX_LENGTH = 300;
export const PATH_MAX_SEGMENTS = 24;

function invalid(path: string, reason: string): never {
  throw new ContentPathError(`Путь «${path}» не разобрать: ${reason}`);
}

export function parsePath(path: string): PathSegment[] {
  if (path === "") return invalid(path, "он пуст");
  if (path.length > PATH_MAX_LENGTH) return invalid(path.slice(0, 40) + "…", `длиннее ${String(PATH_MAX_LENGTH)} знаков`);

  const segments: PathSegment[] = [];
  let position = 0;
  while (position < path.length) {
    // Ключ: после точки обязателен, в начале — тоже.
    let end = position;
    while (end < path.length && KEY_CHARS.test(path.charAt(end))) end += 1;
    const name = path.slice(position, end);
    if (!KEY.test(name)) return invalid(path, name === "" ? `на знаке ${String(position + 1)} ожидался ключ` : `«${name}» — не ключ`);
    if (FORBIDDEN_KEYS.has(name)) return invalid(path, `ключ «${name}» не разрешён`);
    segments.push({ kind: "key", name });
    position = end;

    while (path.charAt(position) === "[") {
      const close = path.indexOf("]", position);
      if (close < 0) return invalid(path, "скобка не закрыта");
      segments.push(bracket(path, path.slice(position + 1, close)));
      position = close + 1;
    }

    if (position === path.length) break;
    if (path.charAt(position) !== ".") return invalid(path, `на знаке ${String(position + 1)} ожидалась точка`);
    position += 1;
    if (position === path.length) return invalid(path, "после точки ничего нет");
  }
  if (segments.length > PATH_MAX_SEGMENTS) return invalid(path, `больше ${String(PATH_MAX_SEGMENTS)} звеньев`);
  return segments;
}

function bracket(path: string, inner: string): PathSegment {
  if (INDEX.test(inner)) return { kind: "index", index: Number(inner) };
  const eq = inner.indexOf("=");
  if (eq > 0) {
    const field = inner.slice(0, eq);
    const value = inner.slice(eq + 1);
    if (KEY.test(field) && !FORBIDDEN_KEYS.has(field) && value !== "" && !value.includes("[")) return { kind: "find", field, value };
  }
  return invalid(path, `в скобках «${inner}» — ожидался индекс (3) или поле=значение (id=swarm_rat)`);
}

/** Путь так, как его пишет человек: обратная операция к `parsePath`. */
export function formatPath(segments: readonly PathSegment[]): string {
  let result = "";
  for (const segment of segments) {
    if (segment.kind === "key") result += result === "" ? segment.name : `.${segment.name}`;
    else if (segment.kind === "index") result += `[${String(segment.index)}]`;
    else result += `[${segment.field}=${segment.value}]`;
  }
  return result;
}

/**
 * Место в данных (ключи и индексы) в виде пути для человека. Элемент списка с
 * уникальными `id` называется по `id`, остальные — по номеру: `enemies[id=swarm_rat].hp`
 * читается, а `enemies[0].hp` приходится расшифровывать.
 */
export function formatPointer(root: unknown, pointer: readonly (string | number)[]): string {
  let node: unknown = root;
  let result = "";
  for (const part of pointer) {
    if (typeof part === "number") {
      const id = idOf(node, part);
      result += id === null ? `[${String(part)}]` : `[id=${id}]`;
    } else {
      result += result === "" ? part : `.${part}`;
    }
    node = child(node, part);
  }
  return result;
}

function child(node: unknown, part: string | number): unknown {
  if (typeof node !== "object" || node === null) return undefined;
  return (node as Record<string | number, unknown>)[part];
}

function idOf(list: unknown, index: number): string | null {
  if (!Array.isArray(list)) return null;
  const ids = list.map((item) => (typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).id === "string" ? ((item as Record<string, unknown>).id as string) : null));
  if (ids.some((id) => id === null) || new Set(ids).size !== ids.length) return null;
  return ids[index] ?? null;
}
