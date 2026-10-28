import { NAME_RULE_LIMITS } from "./name-rules-limits.js";

/**
 * Безопасное подмножество регулярок для правил имён (docs/35-stage4-plan.md,
 * Р168). Регулярку присылает человек, а исполняется она на нике каждого
 * игрока при входе, поэтому катастрофический перебор («ReDoS») должен быть
 * невозможен по построению, а не «маловероятен». Ни `re2`, ни сторонних
 * проверок не ставим: подмножество маленькое, а проверка — один проход.
 *
 * Запрещено то, что даёт экспоненциальный перебор: повтор группы, внутри
 * которой есть повтор или выбор, обратные ссылки и заглядывание. Остаётся
 * полиномиальный перебор от соседних повторов — его ограничивают число
 * повторов без предела и прогон по «злым» строкам при сохранении.
 */

export type SafetyResult = { ok: true } | { ok: false; reason: string };

export const REGEX_REASONS = {
  length: "Регулярка — от 1 до 100 знаков",
  parse: "Регулярка не разбирается",
  backref: "Обратные ссылки не разрешены",
  lookaround: "Заглядывание вперёд и назад не разрешено",
  groupRepeat: "Повтор группы с повтором или выбором внутри не разрешён",
  unbounded: "Не больше трёх повторов без предела",
  repeat: "Предел повтора — не больше 20",
  empty: "Регулярка совпадает с пустой строкой",
  slow: "Регулярка слишком медленная на длинных строках",
} as const;

const fail = (reason: string): SafetyResult => ({ ok: false, reason });

interface Group {
  /** внутри был повтор: `*`, `+` или `{` */
  quantifier: boolean;
  /** внутри был выбор `|` */
  alternation: boolean;
}

/** `{n}`, `{n,}` или `{n,m}` с позиции `{`; иначе `null`. */
function bracesAt(pattern: string, index: number): { min: number; max: number | null; length: number } | null {
  const found = /^\{(\d{1,9})(?:(,)(\d{0,9}))?\}/u.exec(pattern.slice(index, index + 24));
  if (found === null) return null;
  const min = Number(found[1]);
  const max = found[2] === undefined ? min : found[3] === "" ? null : Number(found[3]);
  return { min, max, length: found[0].length };
}

/**
 * Один проход по шаблону. Классы `[...]` пропускаются целиком (внутри них
 * знаки буквальные), экранирование — пара знаков, `\p{..}` и `\u{..}` —
 * вместе с фигурными скобками. Обратная ссылка и заглядывание ищутся до
 * разбора движком: `\1` без группы он отвергнет как «не разбирается», а
 * человеку нужна настоящая причина.
 */
function scan(pattern: string): SafetyResult {
  const stack: Group[] = [];
  let unbounded = 0;
  let index = 0;
  const markQuantifier = (): void => {
    const top = stack.at(-1);
    if (top !== undefined) top.quantifier = true;
  };
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "\\") {
      const next = pattern[index + 1];
      if (next !== undefined && next >= "1" && next <= "9") return fail(REGEX_REASONS.backref);
      if (next === "k" && pattern[index + 2] === "<") return fail(REGEX_REASONS.backref);
      if ((next === "p" || next === "P" || next === "u") && pattern[index + 2] === "{") {
        const close = pattern.indexOf("}", index + 3);
        index = close === -1 ? pattern.length : close + 1;
      } else {
        index += 2;
      }
      continue;
    }
    if (char === "[") {
      index += 1;
      while (index < pattern.length && pattern[index] !== "]") index += pattern[index] === "\\" ? 2 : 1;
      index += 1;
      continue;
    }
    if (char === "(") {
      stack.push({ quantifier: false, alternation: false });
      index += 1;
      if (pattern[index] === "?") {
        const kind = pattern[index + 1];
        if (kind === "=" || kind === "!") return fail(REGEX_REASONS.lookaround);
        if (kind === "<" && (pattern[index + 2] === "=" || pattern[index + 2] === "!")) return fail(REGEX_REASONS.lookaround);
        // «?:» и «?<имя>» — не повторы: пропускаем служебный знак, иначе «?» сошёл бы за квантификатор
        index += 1;
      }
      continue;
    }
    if (char === ")") {
      const group = stack.pop();
      index += 1;
      const next = pattern[index];
      if (group !== undefined) {
        if ((group.quantifier || group.alternation) && (next === "*" || next === "+" || (next === "{" && bracesAt(pattern, index) !== null))) {
          return fail(REGEX_REASONS.groupRepeat);
        }
        // вложенная группа: и повтор, и выбор внутри неё остаются внутри внешней
        const parent = stack.at(-1);
        if (parent !== undefined) {
          parent.quantifier ||= group.quantifier;
          parent.alternation ||= group.alternation;
        }
      }
      continue;
    }
    if (char === "|") {
      const top = stack.at(-1);
      if (top !== undefined) top.alternation = true;
    } else if (char === "*" || char === "+") {
      unbounded += 1;
      markQuantifier();
    } else if (char === "{") {
      const braces = bracesAt(pattern, index);
      if (braces !== null) {
        markQuantifier();
        if (braces.max === null) unbounded += 1;
        else if (braces.max > NAME_RULE_LIMITS.repeatMax) return fail(REGEX_REASONS.repeat);
        index += braces.length;
        continue;
      }
    }
    index += 1;
  }
  return unbounded > NAME_RULE_LIMITS.unboundedMax ? fail(REGEX_REASONS.unbounded) : { ok: true };
}

/** Структурная проверка регулярки правила: форма шаблона, без запуска на строках. */
export function checkRegexSafety(pattern: string): SafetyResult {
  if (pattern.length === 0 || pattern.length > NAME_RULE_LIMITS.patternMax) return fail(REGEX_REASONS.length);
  const scanned = scan(pattern);
  if (!scanned.ok && (scanned.reason === REGEX_REASONS.backref || scanned.reason === REGEX_REASONS.lookaround)) return scanned;
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, "iu");
  } catch {
    return fail(REGEX_REASONS.parse);
  }
  if (!scanned.ok) return scanned;
  return compiled.test("") ? fail(REGEX_REASONS.empty) : { ok: true };
}

/** Строки, на которых плохая регулярка тормозит: длинные повторы, почти совпадения, пробелы, кириллица, цифры. */
const EVIL_INPUTS: readonly string[] = [`${"a".repeat(256)}!`, "ab".repeat(128), `${" ".repeat(256)}x`, `${"х".repeat(256)}-`, `${"1".repeat(255)}я`];

/**
 * Прогон по «злым» строкам: дольше бюджета на любой — отказ. Часы — параметр,
 * чтобы тест не зависел от скорости машины.
 */
export function probeRegex(pattern: string, now: () => number = () => performance.now()): SafetyResult {
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, "iu");
  } catch {
    return fail(REGEX_REASONS.parse);
  }
  for (const input of EVIL_INPUTS) {
    const startedAt = now();
    compiled.test(input);
    if (now() - startedAt > NAME_RULE_LIMITS.probeBudgetMs) return fail(REGEX_REASONS.slow);
  }
  return { ok: true };
}
