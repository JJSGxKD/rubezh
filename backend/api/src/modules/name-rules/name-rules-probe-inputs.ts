import { NAME_RULE_LIMITS } from "./name-rules-limits.js";

/**
 * Строки для прогона регулярки правила (docs/35-stage4-plan.md, Р168).
 * Перебор растёт на строке из знаков, которые шаблон сам умеет повторять, а не
 * на случайных, поэтому строки строятся из «представителей» квантифицированных
 * атомов шаблона, а завершающий знак подбирается такой, которого в шаблоне нет:
 * тогда совпадение не складывается и движок обязан перебрать всё.
 */

/** Длины строк по нарастающей: опасный шаблон упрётся в бюджет на короткой, до зависания. */
const PROBE_LENGTHS: readonly number[] = [16, 32, 64, NAME_RULE_LIMITS.inputMax];

/** Завершающий знак: первый из этих, которого нет в шаблоне. */
const TERMINATORS: readonly string[] = ["!", "~", "§", "\u0001"];

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

/** Представитель класса `[...]` с позиции `[`: и сколько знаков шаблона он занял. */
function classAt(pattern: string, index: number): { rep: string; length: number } {
  let cursor = index + 1;
  while (cursor < pattern.length && pattern[cursor] !== "]") cursor += pattern[cursor] === "\\" ? 2 : 1;
  const length = Math.min(cursor + 1, pattern.length) - index;
  const source = pattern.slice(index, index + length);
  const body = source.slice(1, source.endsWith("]") ? -1 : undefined);
  if (body.startsWith("^")) {
    try {
      const negated = new RegExp(source, "iu");
      return { rep: OUTSIDERS.find((candidate) => negated.test(candidate)) ?? "a", length };
    } catch {
      return { rep: "a", length };
    }
  }
  if (body === "") return { rep: "a", length };
  return { rep: body[0] === "\\" ? escapeAt(body, 0).rep || "a" : (String.fromCodePoint(body.codePointAt(0) ?? 97)), length };
}

interface Frame {
  /** представители атомов первой альтернативы группы */
  items: string[];
  /** встретился `|`: остальные альтернативы в представителя группы не входят */
  stopped: boolean;
}

/**
 * Представители атомов, за которыми стоит квантификатор: они и повторяются в
 * опасном перебое. Шаблон уже прошёл разбор, но функция не падает и на
 * неразобранном — вернёт то, что успела.
 */
export function quantifiedRepresentatives(pattern: string): string[] {
  const found = new Set<string>();
  const frames: Frame[] = [{ items: [], stopped: false }];
  let last = "";
  let lastWasQuantifier = false;
  let index = 0;
  const atom = (rep: string): void => {
    last = rep;
    const top = frames.at(-1);
    if (top !== undefined && !top.stopped && rep !== "") top.items.push(rep);
  };
  const quantifier = (): void => {
    if (last !== "") found.add(last);
  };
  while (index < pattern.length) {
    const char = pattern[index] ?? "";
    const wasQuantifier = lastWasQuantifier;
    lastWasQuantifier = false;
    if (char === "\\") {
      const escaped = escapeAt(pattern, index);
      atom(escaped.rep);
      index += escaped.length;
    } else if (char === "[") {
      const parsed = classAt(pattern, index);
      atom(parsed.rep);
      index += parsed.length;
    } else if (char === "(") {
      frames.push({ items: [], stopped: false });
      last = "";
      index += 1;
      if (pattern[index] === "?") {
        index += 1;
        if (pattern[index] === "<" && pattern[index + 1] !== "=" && pattern[index + 1] !== "!") {
          const close = pattern.indexOf(">", index);
          index = close === -1 ? pattern.length : close + 1;
        } else index += 1;
      }
    } else if (char === ")") {
      const frame = frames.length > 1 ? frames.pop() : undefined;
      index += 1;
      atom((frame?.items ?? []).join(""));
    } else if (char === "|") {
      const top = frames.at(-1);
      if (top !== undefined) top.stopped = true;
      last = "";
      index += 1;
    } else if (char === "*" || char === "+") {
      quantifier();
      lastWasQuantifier = true;
      index += 1;
    } else if (char === "?") {
      // «?» за квантификатором — ленивый суффикс, а не новый повтор
      if (!wasQuantifier) {
        quantifier();
        lastWasQuantifier = true;
      }
      index += 1;
    } else if (char === "{") {
      const braces = /^\{\d{1,9}(?:,\d{0,9})?\}/u.exec(pattern.slice(index, index + 24));
      if (braces === null) {
        atom("{");
        index += 1;
      } else {
        quantifier();
        lastWasQuantifier = true;
        index += braces[0].length;
      }
    } else if (char === "^" || char === "$") {
      last = "";
      index += 1;
    } else if (char === ".") {
      atom("a");
      index += 1;
    } else {
      const code = pattern.codePointAt(index) ?? 97;
      atom(String.fromCodePoint(code));
      index += code > 0xffff ? 2 : 1;
    }
  }
  return [...found];
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
 * шаблона — по одной на квантифицированный атом и общая по кругу.
 */
export function probeInputs(pattern: string): string[] {
  const max = NAME_RULE_LIMITS.inputMax;
  const inputs: string[] = [`${"a".repeat(max - 1)}!`, "ab".repeat(max / 2), `${" ".repeat(max - 1)}x`, `${"х".repeat(max - 1)}-`, `${"1".repeat(max - 1)}я`];
  const atoms = quantifiedRepresentatives(pattern);
  if (atoms.length === 0) return inputs;
  const terminator = TERMINATORS.find((candidate) => !pattern.includes(candidate)) ?? "\u0001";
  for (const length of PROBE_LENGTHS) {
    for (const atom of atoms) inputs.push(build([atom], length, terminator));
    if (atoms.length > 1) inputs.push(build(atoms, length, terminator));
  }
  // Короткие первыми (сортировка устойчива): опасный шаблон отказывает на короткой строке, не дойдя до длинной.
  return inputs.sort((a, b) => a.length - b.length);
}
