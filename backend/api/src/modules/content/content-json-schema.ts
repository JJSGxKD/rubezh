import { ContentSchemaError } from "./content-errors.js";

/**
 * Проверка значения по JSON Schema снимка (docs/19-content-admin.md §3,
 * tasks/T-0303). Схема едет вместе с выгрузкой `content:export` (`z.toJSONSchema`
 * схемы снимка): сервер её не дублирует и пакеты игры не импортирует, поэтому
 * нужен проверяющий. Готовой библиотеки в зависимостях нет, а Zod сам строит
 * ровно такой поднабор ключевых слов — его здесь и разбираем.
 *
 * **Незнакомое ключевое слово — отказ, а не «подходит».** Проверка, молча
 * пропустившая то, чего не поняла, хуже отсутствующей: схема обновится, а
 * сервер продолжит пускать неверное. Новое слово появится в выгрузке — первый
 * же импорт упадёт и скажет, какое.
 */

export interface SchemaViolation {
  /** место в значении: ключи и индексы от корня */
  pointer: (string | number)[];
  /** что не так, по-русски */
  message: string;
}

/** Пояснения схемы: на проверку не влияют. */
const ANNOTATIONS: ReadonlySet<string> = new Set(["$schema", "$id", "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"]);

const KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "properties",
  "required",
  "additionalProperties",
  "propertyNames",
  "anyOf",
  "oneOf",
  "allOf",
]);

/** Сколько нарушений собирать: остальное — «исправьте эти и повторите». */
export const VIOLATIONS_LIMIT = 20;

type Schema = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Вся схема целиком на знакомые слова: нужна при импорте, чтобы не ждать первой правки. */
export function assertSchemaSupported(schema: unknown): void {
  if (typeof schema === "boolean") return;
  if (!isObject(schema)) throw new ContentSchemaError("не объект");
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key)) continue;
    if (!KEYWORDS.has(key)) throw new ContentSchemaError(key);
    if (key === "properties" && isObject(value)) Object.values(value).forEach(assertSchemaSupported);
    else if ((key === "items" || key === "additionalProperties" || key === "propertyNames") && value !== undefined) assertSchemaSupported(value);
    else if ((key === "prefixItems" || key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) value.forEach(assertSchemaSupported);
  }
}

export function validateJsonSchema(schema: unknown, value: unknown, limit = VIOLATIONS_LIMIT): SchemaViolation[] {
  const out: SchemaViolation[] = [];
  check(schema, value, [], out, limit);
  return out;
}

function check(schema: unknown, value: unknown, pointer: (string | number)[], out: SchemaViolation[], limit: number): void {
  if (out.length >= limit) return;
  if (schema === true) return;
  if (schema === false) {
    fail(out, pointer, "значение здесь не допускается");
    return;
  }
  if (!isObject(schema)) throw new ContentSchemaError("не объект");
  for (const key of Object.keys(schema)) {
    if (!ANNOTATIONS.has(key) && !KEYWORDS.has(key)) throw new ContentSchemaError(key);
  }

  if (schema.type !== undefined && !typeMatches(schema.type, value)) {
    fail(out, pointer, `ожидалось ${typeNames(schema.type)}, получено ${actualName(value)}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => sameJson(item, value))) {
    fail(out, pointer, `значение должно быть одним из: ${schema.enum.map(show).join(", ")}`);
  }
  if ("const" in schema && !sameJson(schema.const, value)) fail(out, pointer, `значение должно быть ${show(schema.const)}`);

  if (typeof value === "number") checkNumber(schema, value, pointer, out);
  else if (typeof value === "string") checkString(schema, value, pointer, out);
  else if (Array.isArray(value)) checkArray(schema, value, pointer, out, limit);
  else if (isObject(value)) checkObject(schema, value, pointer, out, limit);

  if (Array.isArray(schema.allOf)) for (const branch of schema.allOf) check(branch, value, pointer, out, limit);
  if (Array.isArray(schema.anyOf)) checkUnion(schema.anyOf, value, pointer, out, limit, false);
  if (Array.isArray(schema.oneOf)) checkUnion(schema.oneOf, value, pointer, out, limit, true);
}

function fail(out: SchemaViolation[], pointer: readonly (string | number)[], message: string): void {
  out.push({ pointer: [...pointer], message });
}

function typeMatches(type: unknown, value: unknown): boolean {
  if (Array.isArray(type)) return type.some((item) => typeMatches(item, value));
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    default:
      throw new ContentSchemaError(`type: ${String(type)}`);
  }
}

const TYPE_NAMES: Record<string, string> = {
  string: "строка",
  number: "число",
  integer: "целое число",
  boolean: "логическое значение",
  null: "null",
  array: "список",
  object: "объект",
};

function typeNames(type: unknown): string {
  return (Array.isArray(type) ? type : [type]).map((item) => TYPE_NAMES[String(item)] ?? String(item)).join(" или ");
}

function actualName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "список";
  if (typeof value === "number") return Number.isInteger(value) ? "целое число" : "дробное число";
  if (typeof value === "string") return "строка";
  if (typeof value === "boolean") return "логическое значение";
  if (typeof value === "object") return "объект";
  return "ничего";
}

const show = (value: unknown): string => (typeof value === "string" ? `«${value}»` : JSON.stringify(value));
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function checkNumber(schema: Schema, value: number, pointer: (string | number)[], out: SchemaViolation[]): void {
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum } = schema;
  if (typeof minimum === "number" && value < minimum) fail(out, pointer, `должно быть не меньше ${String(minimum)}`);
  if (typeof maximum === "number" && value > maximum) fail(out, pointer, `должно быть не больше ${String(maximum)}`);
  if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum) fail(out, pointer, `должно быть больше ${String(exclusiveMinimum)}`);
  if (typeof exclusiveMaximum === "number" && value >= exclusiveMaximum) fail(out, pointer, `должно быть меньше ${String(exclusiveMaximum)}`);
}

function checkString(schema: Schema, value: string, pointer: (string | number)[], out: SchemaViolation[]): void {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) fail(out, pointer, schema.minLength === 1 ? "не может быть пустой" : `должна быть не короче ${String(schema.minLength)} знаков`);
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) fail(out, pointer, `должна быть не длиннее ${String(schema.maxLength)} знаков`);
  // Шаблон приходит из нашей же выгрузки, а не от пользователя панели.
  if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) fail(out, pointer, "не подходит под формат");
}

function checkArray(schema: Schema, value: unknown[], pointer: (string | number)[], out: SchemaViolation[], limit: number): void {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) fail(out, pointer, `в списке должно быть не меньше ${String(schema.minItems)} элементов`);
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) fail(out, pointer, `в списке должно быть не больше ${String(schema.maxItems)} элементов`);
  const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
  value.forEach((item, index) => {
    if (index < prefix.length) check(prefix[index], item, [...pointer, index], out, limit);
    else if (schema.items !== undefined) check(schema.items, item, [...pointer, index], out, limit);
  });
}

function checkObject(schema: Schema, value: Record<string, unknown>, pointer: (string | number)[], out: SchemaViolation[], limit: number): void {
  if (Array.isArray(schema.required)) {
    for (const name of schema.required) {
      if (typeof name === "string" && !Object.hasOwn(value, name)) fail(out, pointer, `нет обязательного поля «${name}»`);
    }
  }
  const properties = isObject(schema.properties) ? schema.properties : {};
  for (const [name, inner] of Object.entries(value)) {
    if (out.length >= limit) return;
    if (schema.propertyNames !== undefined) {
      const named: SchemaViolation[] = [];
      check(schema.propertyNames, name, [], named, 1);
      if (named.length > 0) fail(out, [...pointer, name], `имя поля «${name}» не допускается: ${named[0]?.message ?? ""}`);
    }
    if (Object.hasOwn(properties, name)) check(properties[name], inner, [...pointer, name], out, limit);
    else if (schema.additionalProperties === false) fail(out, [...pointer, name], "поле не предусмотрено схемой");
    else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) check(schema.additionalProperties, inner, [...pointer, name], out, limit);
  }
}

/**
 * Объединение: подошёл хоть один вариант (для `oneOf` — ровно один). Если не
 * подошёл ни один, человеку нужна причина, а не «не подходит ни под что»:
 * называем нарушения того варианта, где их меньше всего, — у союза по полю-
 * признаку это вариант с совпавшим признаком.
 */
function checkUnion(branches: unknown[], value: unknown, pointer: (string | number)[], out: SchemaViolation[], limit: number, exactlyOne: boolean): void {
  let matched = 0;
  let best: SchemaViolation[] | null = null;
  for (const branch of branches) {
    const own: SchemaViolation[] = [];
    check(branch, value, pointer, own, limit);
    if (own.length === 0) matched += 1;
    else if (best === null || own.length < best.length) best = own;
  }
  if (matched === 0) {
    if (best === null) fail(out, pointer, "значение не подходит ни под один вариант");
    else out.push(...best);
  } else if (exactlyOne && matched > 1) {
    fail(out, pointer, "значение подходит сразу под несколько вариантов");
  }
}
