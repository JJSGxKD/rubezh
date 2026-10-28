import { NAME_RULE_LIMITS } from "./name-rules-limits.js";

/**
 * Строки для прогона регулярки правила (docs/35-stage4-plan.md, Р168).
 * Перебор растёт на строке из знаков, которые шаблон сам умеет повторять, а не
 * на случайных. Опасно пересечение соседних атомов: общий знак может оказаться
 * не первым ни в одном из классов или диапазонов, поэтому строки строятся из
 * всех знаков шаблона (литералы, все члены классов, обе границы каждого
 * диапазона: пересечение двух диапазонов всегда содержит границу одного из
 * них), а завершающий знак подбирается такой, которого в шаблоне нет: тогда
 * совпадение не складывается и движок обязан перебрать всё.
 */

/** Длины строк по нарастающей: опасный шаблон упрётся в бюджет на короткой, до зависания. */
const PROBE_LENGTHS: readonly number[] = [16, 32, 64, NAME_RULE_LIMITS.inputMax];

/** Знаки, которых может не быть в шаблоне: первый отсутствующий — завершающий и запасной представитель. */
const ABSENT_CANDIDATES: readonly string[] = ["!", "~", "§", "\u0001"];

/** Запасные представители для `.`, `\w`, `\d`, `\s` и отрицательных классов. */
const FALLBACKS: readonly string[] = ["а", "a", "1", " "];

/** Знаки для отрицательных классов и `\W`: первый, который класс пропускает. */
const OUTSIDERS: readonly string[] = ["a", "1", "ж", "!", "~", " "];

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { d: "1", w: "a", s: " ", D: "a", W: "-", S: "a", n: "\n", t: "\t", r: "\r", f: "\f", v: "\v" };

/** Представитель экранирования с позиции `\`: сам знак, и сколько знаков шаблона он занял. `rep === ""` — нулевая ширина. */
function escapeAt(pattern: string, index: number): { rep: string; length: number } {
  const next = pattern[index + 1];
  if (next === undefined) return { rep: "", length: 1 };
  if (next === "b" || next === "B") return { rep: "", length: 2 };
  if (next === "p" || next === "P") {
    const close = pattern[index + 2] === "{" ? pattern.indexOf("}", index + 3) : -1;
    return { rep: "a", length: close === -1 ? 2 : close - index + 1 };
  }
  if (next === "u" && pattern[index + 2] === "{") {
    const close = pattern.indexOf("}", index + 3);
    const code = close === -1 ? Number.NaN : Number.parseInt(pattern.slice(index + 3, close), 16);
    return { rep: Number.isInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : "a", length: close === -1 ? 2 : close - index + 1 };
  }
  const hexLength = next === "u" ? 4 : next === "x" ? 2 : 0;
  if (hexLength > 0) {
    const hex = pattern.slice(index + 2, index + 2 + hexLength);
    if (hex.length === hexLength && /^[0-9a-f]+$/iu.test(hex)) return { rep: String.fromCharCode(Number.parseInt(hex, 16)), length: 2 + hexLength };
    return { rep: next, length: 2 };
  }
  return { rep: SIMPLE_ESCAPES[next] ?? next, length: 2 };
}

/** Один знак тела класса с позиции `index`: сам знак (или представитель экранирования) и сколько знаков занял. */
function classItemAt(body: string, index: number): { rep: string; length: number } {
  if (body[index] === "\\") return escapeAt(body, index);
  const code = body.codePointAt(index) ?? 97;
  return { rep: String.fromCodePoint(code), length: code > 0xffff ? 2 : 1 };
}

/** Все знаки класса `[...]` с позиции `[`: члены и обе границы диапазонов, и сколько знаков шаблона класс занял. */
function classAt(pattern: string, index: number): { reps: string[]; length: number } {
  let cursor = index + 1;
  while (cursor < pattern.length && pattern[cursor] !== "]") cursor += pattern[cursor] === "\\" ? 2 : 1;
  const length = Math.min(cursor + 1, pattern.length) - index;
  const source = pattern.slice(index, index + length);
  const body = source.slice(1, source.endsWith("]") ? -1 : undefined);
  const reps: string[] = [];
  const negated = body.startsWith("^");
  let position = negated ? 1 : 0;
  while (position < body.length) {
    const item = classItemAt(body, position);
    position += item.length;
    if (item.rep !== "") reps.push(item.rep);
    // «-» между двумя знаками — диапазон: нужна и вторая граница
    if (body[position] === "-" && position + 1 < body.length) {
      const end = classItemAt(body, position + 1);
      position += 1 + end.length;
      if (end.rep !== "") reps.push(end.rep);
    }
  }
  if (negated) {
    try {
      const compiled = new RegExp(source, "iu");
      reps.push(OUTSIDERS.find((candidate) => compiled.test(candidate)) ?? "a");
    } catch {
      reps.push("a");
    }
  }
  return { reps, length };
}

/** Длина квантификатора `{n}`, `{n,}`, `{n,m}` с позиции `{`; 0 — это не квантификатор, а буквальная скобка. */
function bracesLength(pattern: string, index: number): number {
  return /^\{\d{1,9}(?:,\d{0,9})?\}/u.exec(pattern.slice(index, index + 24))?.[0].length ?? 0;
}

/** Первый знак из кандидатов, которого в шаблоне нет. */
function absentChar(pattern: string): string {
  return ABSENT_CANDIDATES.find((candidate) => !pattern.includes(candidate)) ?? "\u0001";
}

/**
 * Представители знаков шаблона: литералы, все члены классов, обе границы
 * диапазонов, представители экранирований; к ним запасные — для `.`, `\w`,
 * `\d`, `\s` и отрицательных классов. Дублей нет, число ограничено длиной
 * шаблона. Шаблон уже прошёл разбор, но функция не падает и на неразобранном.
 */
export function patternRepresentatives(pattern: string): string[] {
  const found = new Set<string>();
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index] ?? "";
    if (char === "\\") {
      const escaped = escapeAt(pattern, index);
      if (escaped.rep !== "") found.add(escaped.rep);
      index += escaped.length;
    } else if (char === "[") {
      const parsed = classAt(pattern, index);
      for (const rep of parsed.reps) found.add(rep);
      index += parsed.length;
    } else if (char === "(") {
      index += 1;
      if (pattern[index] === "?") {
        index += 1;
        if (pattern[index] === "<" && pattern[index + 1] !== "=" && pattern[index + 1] !== "!") {
          const close = pattern.indexOf(">", index);
          index = close === -1 ? pattern.length : close + 1;
        } else index += 1;
      }
    } else if (char === "{" && bracesLength(pattern, index) > 0) {
      index += bracesLength(pattern, index);
    } else if (char === ")" || char === "|" || char === "*" || char === "+" || char === "?" || char === "^" || char === "$" || char === ".") {
      index += 1;
    } else {
      const code = pattern.codePointAt(index) ?? 97;
      found.add(String.fromCodePoint(code));
      index += code > 0xffff ? 2 : 1;
    }
  }
  for (const fallback of FALLBACKS) found.add(fallback);
  found.add(absentChar(pattern));
  return [...found].slice(0, NAME_RULE_LIMITS.patternMax);
}

/** Строка заданной длины из повторов `parts` по кругу, с завершающим знаком в конце. */
function build(parts: readonly string[], length: number, terminator: string): string {
  let body = "";
  while (body.length < length - 1) {
    for (const part of parts) body += part;
  }
  return body.slice(0, length - 1) + terminator;
}

/**
 * Строки прогона по возрастанию длины: прежние фиксированные (длинные повторы,
 * почти совпадения, пробелы, кириллица, цифры) и строки из знаков самого
 * шаблона — по одной на каждого представителя и общая по кругу.
 */
export function probeInputs(pattern: string): string[] {
  const max = NAME_RULE_LIMITS.inputMax;
  const inputs: string[] = [`${"a".repeat(max - 1)}!`, "ab".repeat(max / 2), `${" ".repeat(max - 1)}x`, `${"х".repeat(max - 1)}-`, `${"1".repeat(max - 1)}я`];
  const representatives = patternRepresentatives(pattern);
  const terminator = absentChar(pattern);
  for (const length of PROBE_LENGTHS) {
    for (const representative of representatives) inputs.push(build([representative], length, terminator));
    inputs.push(build(representatives, length, terminator));
  }
  // Короткие первыми (сортировка устойчива): опасный шаблон отказывает на короткой строке, не дойдя до длинной.
  return inputs.sort((a, b) => a.length - b.length);
}
