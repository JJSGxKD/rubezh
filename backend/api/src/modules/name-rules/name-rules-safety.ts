import { probeInputs } from "./name-rules-probe-inputs.js";
import { NAME_RULE_LIMITS } from "./name-rules-limits.js";

/**
 * Безопасное подмножество регулярок для правил имён (docs/35-stage4-plan.md,
 * Р168). Регулярку присылает человек, а исполняется она на нике каждого
 * игрока при входе, поэтому катастрофический перебор («ReDoS») должен быть
 * невозможен по построению, а не «маловероятен». Ни `re2`, ни сторонних
 * проверок не ставим: подмножество маленькое, а проверка — один проход.
 *
 * Запрещено то, что даёт экспоненциальный перебор: повтор группы, внутри
 * которой есть повтор (в том числе «?») или выбор, обратные ссылки и
 * заглядывание. Остаётся полиномиальный перебор от соседних повторов — его
 * ограничивают число повторов без предела, общее число квантификаторов,
 * предел повтора и прогон по «злым» строкам при сохранении.
 */

export type SafetyResult = { ok: true } | { ok: false; reason: string };

export const REGEX_REASONS = {
  length: "Регулярка — от 1 до 100 знаков",
  parse: "Регулярка не разбирается",
  backref: "Обратные ссылки не разрешены",
  lookaround: "Заглядывание вперёд и назад не разрешено",
  groupRepeat: "Повтор группы с повтором или выбором внутри не разрешён",
  unbounded: "Не больше трёх повторов без предела",
  repeat: "Предел повтора — не больше 10",
  quantifiers: "Не больше шести повторов в шаблоне",
  empty: "Регулярка совпадает с пустой строкой",
  slow: "Шаблон слишком медленный на длинных никах",
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
  let quantifiers = 0;
  let lastWasQuantifier = false;
  let index = 0;
  /** Учитывает квантификатор: он есть у охватывающей группы и в общем счёте шаблона. */
  const countQuantifier = (): void => {
    quantifiers += 1;
    lastWasQuantifier = true;
    const top = stack.at(-1);
    if (top !== undefined) top.quantifier = true;
  };
  while (index < pattern.length) {
    const char = pattern[index];
    // «?» сразу за квантификатором — ленивый суффикс, часть того же квантификатора
    const afterQuantifier = lastWasQuantifier;
    lastWasQuantifier = false;
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
      countQuantifier();
    } else if (char === "?") {
      if (!afterQuantifier) countQuantifier();
    } else if (char === "{") {
      const braces = bracesAt(pattern, index);
      if (braces !== null) {
        countQuantifier();
        if (braces.max === null) unbounded += 1;
        else if (braces.max > NAME_RULE_LIMITS.repeatMax) return fail(REGEX_REASONS.repeat);
        if (quantifiers > NAME_RULE_LIMITS.quantifierMax) return fail(REGEX_REASONS.quantifiers);
        index += braces.length;
        continue;
      }
    }
    if (quantifiers > NAME_RULE_LIMITS.quantifierMax) return fail(REGEX_REASONS.quantifiers);
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

/** Замер больше этой доли бюджета — не помеха сборщика мусора, а настоящая медленность: повторять незачем. */
const RECHECK_MAX_FACTOR = 10;

function measure(compiled: RegExp, input: string, now: () => number): number {
  const startedAt = now();
  compiled.test(input);
  return now() - startedAt;
}

/**
 * Прогон по «злым» строкам и по знакам самого шаблона, длиной по нарастающей:
 * дольше бюджета на любой строке или на шаблоне в целом — отказ, и более
 * длинные строки уже не гоняются. Превысившая строка замеряется второй раз:
 * один замер бывает испорчен паузой сборщика мусора. Часы — параметр, чтобы
 * тест не зависел от скорости машины.
 */
export function probeRegex(pattern: string, now: () => number = () => performance.now()): SafetyResult {
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, "iu");
  } catch {
    return fail(REGEX_REASONS.parse);
  }
  const budget = NAME_RULE_LIMITS.probeBudgetMs;
  let total = 0;
  for (const input of probeInputs(pattern)) {
    let spent = measure(compiled, input, now);
    if (spent > budget && spent <= budget * RECHECK_MAX_FACTOR) spent = measure(compiled, input, now);
    if (spent > budget) return fail(REGEX_REASONS.slow);
    total += spent;
    if (total > NAME_RULE_LIMITS.probeTotalMs) return fail(REGEX_REASONS.slow);
  }
  return { ok: true };
}

