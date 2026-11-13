import { ContentPathError, ContentValueError } from "./content-errors.js";
import { validateJsonSchema } from "./content-json-schema.js";
import { formatPath, formatPointer, parsePath, type PathSegment } from "./content-path.js";

/**
 * Правка снимка по пути (docs/19-content-admin.md §3, tasks/T-0303): значение
 * ставится на место, затем снимок целиком проверяется схемой, и не та форма —
 * 422 с путём до поля. Функция чистая: исходный снимок не меняется, результат —
 * новый объект. Сохраняет его вызывающий, когда правка прошла.
 */

export interface EditInput {
  snapshot: unknown;
  /** JSON Schema версии-основы черновика */
  jsonSchema: unknown;
  path: string;
  value: unknown;
}

export interface EditResult {
  next: unknown;
  /** что было на месте; `null` — поля не было (правка его добавила) */
  from: unknown;
  to: unknown;
}

type Pointer = (string | number)[];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function editSnapshot(input: EditInput): EditResult {
  const segments = parsePath(input.path);
  if (input.value === undefined) throw new ContentValueError(`${input.path}: значение не задано`);
  // Копия через JSON: так же снимок живёт в базе, и в нём не остаётся ни `undefined`, ни общих ссылок с телом запроса.
  const root: unknown = JSON.parse(JSON.stringify(input.snapshot));
  const value: unknown = JSON.parse(JSON.stringify(input.value));

  const pointer: Pointer = [];
  let node: unknown = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as PathSegment;
    const step = descend(node, segment, formatPath(segments.slice(0, index + 1)));
    pointer.push(step.part);
    node = step.node;
  }

  const last = segments[segments.length - 1] as PathSegment;
  const from = place(node, last, value, formatPath(segments), pointer);

  const violations = validateJsonSchema(input.jsonSchema, root);
  // Снимок-основа схеме соответствует, поэтому нарушение — следствие правки; ближайшим к месту правки отвечаем первым.
  const relevant = violations.find((violation) => startsWith(violation.pointer, pointer)) ?? violations[0];
  if (relevant !== undefined) throw new ContentValueError(`${formatPointer(root, relevant.pointer) || input.path}: ${relevant.message}`);
  return { next: root, from, to: value };
}

const startsWith = (pointer: readonly (string | number)[], prefix: readonly (string | number)[]): boolean => prefix.every((part, index) => pointer[index] === part);

/** Шаг вглубь по звену пути; не нашлось — 422 с тем куском пути, на котором оборвалось. */
function descend(node: unknown, segment: PathSegment, shown: string): { node: unknown; part: string | number } {
  if (segment.kind === "key") {
    if (!isObject(node) || !Object.hasOwn(node, segment.name)) throw new ContentPathError(`${shown}: такого поля нет`);
    return { node: node[segment.name], part: segment.name };
  }
  if (!Array.isArray(node)) throw new ContentPathError(`${shown}: здесь не список`);
  if (segment.kind === "index") {
    if (segment.index >= node.length) throw new ContentPathError(`${shown}: в списке ${String(node.length)} элементов, а нужен номер ${String(segment.index)}`);
    return { node: node[segment.index], part: segment.index };
  }
  const found = matches(node, segment);
  if (found.length === 0) throw new ContentPathError(`${shown}: элемента с ${segment.field} «${segment.value}» нет`);
  if (found.length > 1) throw new ContentPathError(`${shown}: элементов с ${segment.field} «${segment.value}» несколько — путь неоднозначен`);
  return { node: node[found[0] as number], part: found[0] as number };
}

function matches(list: unknown[], segment: { field: string; value: string }): number[] {
  const result: number[] = [];
  list.forEach((item, index) => {
    if (isObject(item) && Object.hasOwn(item, segment.field) && String(item[segment.field]) === segment.value) result.push(index);
  });
  return result;
}

/** Последнее звено: поставить значение на место и вернуть прежнее. */
function place(node: unknown, segment: PathSegment, value: unknown, shown: string, pointer: Pointer): unknown {
  if (segment.kind === "key") {
    if (!isObject(node)) throw new ContentPathError(`${shown}: здесь не объект`);
    const from = Object.hasOwn(node, segment.name) ? node[segment.name] : null;
    // Свойство задаётся определением, а не присваиванием: ключ, совпавший с именем из прототипа, остаётся полем.
    Object.defineProperty(node, segment.name, { value, writable: true, enumerable: true, configurable: true });
    pointer.push(segment.name);
    return from;
  }
  if (!Array.isArray(node)) throw new ContentPathError(`${shown}: здесь не список`);
  if (segment.kind === "index") {
    if (segment.index >= node.length) throw new ContentPathError(`${shown}: в списке ${String(node.length)} элементов, а нужен номер ${String(segment.index)}`);
    const from = node[segment.index];
    node[segment.index] = value;
    pointer.push(segment.index);
    return from;
  }
  const found = matches(node, segment);
  if (found.length === 0) throw new ContentPathError(`${shown}: элемента с ${segment.field} «${segment.value}» нет`);
  if (found.length > 1) throw new ContentPathError(`${shown}: элементов с ${segment.field} «${segment.value}» несколько — путь неоднозначен`);
  const at = found[0] as number;
  const from = node[at];
  node[at] = value;
  pointer.push(at);
  return from;
}
