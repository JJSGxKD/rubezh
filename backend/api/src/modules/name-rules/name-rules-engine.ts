import { createHash } from "node:crypto";
import { NAME_RULE_CATEGORIES, NAME_RULE_LIMITS, type NameRuleCategory, type NameRuleKind } from "./name-rules-limits.js";
import { checkRegexSafety, probeRegex } from "./name-rules-safety.js";

/**
 * Движок правил фильтра имён (docs/35-stage4-plan.md, Р168): чистые функции
 * без Nest, базы и настроек. Из `auth/` сюда ничего не приходит — наоборот,
 * чистка ника (`auth/display-name.ts`) вызывает движок.
 *
 * Категория задаёт действие: `brand`, `ads`, `other` вырезают совпавшее,
 * `profanity` заменяет ник целиком, `allow` — исключение: совпавшее не
 * трогается ни правилами, ни встроенным словарём.
 */

export interface NameRuleDef {
  ruleId: string;
  category: NameRuleCategory;
  kind: NameRuleKind;
  pattern: string;
}

/** [start, end) в знаках UTF-16 исходной строки */
export interface Span {
  start: number;
  end: number;
}

/** Непрозрачный скомпилированный набор: устройство знает только движок. */
export interface NameRuleSet {
  readonly size: number;
  readonly signature: string;
}

export interface RulesVerdict {
  /** ник после вырезания правилами `brand`/`ads`/`other` (пробелы не свёрнуты) */
  text: string;
  /** правило `profanity` сработало: ник заменяется целиком */
  profane: boolean;
  /** id правил, которые изменили результат: вырезали или заменили ник */
  hits: string[];
  /** id исключений, которые спасли строку от срабатывания */
  saved: string[];
}

interface CompiledRule {
  ruleId: string;
  category: NameRuleCategory;
  kind: NameRuleKind;
  /** свёрнутый шаблон для `exact` и `word` */
  folded: string;
  regex: RegExp | null;
}

/** Содержимое наборов лежит рядом, а не в самом объекте: снаружи набор — только размер и подпись. */
const COMPILED = new WeakMap<NameRuleSet, readonly CompiledRule[]>();

export const EMPTY_NAME_RULES: NameRuleSet = Object.freeze({ size: 0, signature: "" });

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const CUTTING: readonly NameRuleCategory[] = ["brand", "ads", "other"];

/**
 * Регистр и «ё» → «е» по кодовым точкам. Знак, у которого понижение регистра
 * меняет длину («İ» даёт два знака), остаётся как есть: индексы свёрнутой
 * строки обязаны совпадать с индексами исходной — по ним режется исходник.
 */
export function foldForRules(text: string): string {
  let result = "";
  for (const char of text) {
    const lower = char.toLowerCase();
    const same = lower.length === char.length ? lower : char;
    result += same === "ё" || same === "Ё" ? "е" : same;
  }
  return result;
}

/** Подпись набора определений: одинаковый набор — одинаковая подпись, в каком бы порядке он ни пришёл. */
export function nameRulesSignature(defs: readonly NameRuleDef[]): string {
  const lines = defs.map((def) => `${def.ruleId}|${def.category}|${def.kind}|${def.pattern}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function compileOne(def: NameRuleDef): { rule: CompiledRule } | { reason: string } {
  if (def.kind === "regex") {
    const safety = checkRegexSafety(def.pattern);
    if (!safety.ok) return { reason: safety.reason };
    // Прогон по «злым» строкам — второй раз после сохранения: правило могли записать мимо панели.
    // Один замер бывает испорчен паузой сборщика мусора, поэтому отказ подтверждается повтором.
    const probe = probeRegex(def.pattern);
    if (!probe.ok && !probeRegex(def.pattern).ok) return { reason: probe.reason };
    return { rule: { ruleId: def.ruleId, category: def.category, kind: def.kind, folded: "", regex: new RegExp(def.pattern, "giu") } };
  }
  const folded = foldForRules(def.pattern);
  if (folded === "") return { reason: "Шаблон пуст" };
  return { rule: { ruleId: def.ruleId, category: def.category, kind: def.kind, folded, regex: null } };
}

/**
 * Набор из определений. Плохое определение пропускается с причиной в
 * `onInvalid`, остальные работают: одно битое правило не должно ронять вход.
 */
export function compileNameRules(defs: readonly NameRuleDef[], onInvalid?: (def: NameRuleDef, reason: string) => void): NameRuleSet {
  const compiled: CompiledRule[] = [];
  for (const def of defs) {
    const result = compileOne(def);
    if ("rule" in result) compiled.push(result.rule);
    else onInvalid?.(def, result.reason);
  }
  // Порядок применения не зависит от порядка строк в базе: категория, затем id.
  compiled.sort((a, b) => NAME_RULE_CATEGORIES.indexOf(a.category) - NAME_RULE_CATEGORIES.indexOf(b.category) || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
  const set: NameRuleSet = Object.freeze({ size: compiled.length, signature: nameRulesSignature(defs) });
  COMPILED.set(set, compiled);
  return set;
}

/** Ник, который смотрят правила: не длиннее предела и без разрыва суррогатной пары. */
function headLength(name: string): number {
  if (name.length <= NAME_RULE_LIMITS.inputMax) return name.length;
  const cut = NAME_RULE_LIMITS.inputMax;
  const code = name.charCodeAt(cut - 1);
  return code >= 0xd800 && code <= 0xdbff ? cut - 1 : cut;
}

function isWordAt(text: string, index: number, direction: "before" | "after"): boolean {
  if (direction === "after") {
    const code = text.codePointAt(index);
    return code !== undefined && WORD_CHAR.test(String.fromCodePoint(code));
  }
  if (index <= 0) return false;
  const low = text.charCodeAt(index - 1);
  const start = low >= 0xdc00 && low <= 0xdfff && index >= 2 ? index - 2 : index - 1;
  const code = text.codePointAt(start);
  return code !== undefined && WORD_CHAR.test(String.fromCodePoint(code));
}

function phraseSpans(folded: string, pattern: string, wholeWord: boolean): Span[] {
  const spans: Span[] = [];
  let from = 0;
  while (spans.length < NAME_RULE_LIMITS.matchesPerRule) {
    const start = folded.indexOf(pattern, from);
    if (start === -1) break;
    const end = start + pattern.length;
    if (wholeWord && (isWordAt(folded, start, "before") || isWordAt(folded, end, "after"))) {
      from = start + 1;
      continue;
    }
    spans.push({ start, end });
    from = end;
  }
  return spans;
}

function regexSpans(regex: RegExp, text: string): Span[] {
  const spans: Span[] = [];
  regex.lastIndex = 0;
  for (let match = regex.exec(text); match !== null && spans.length < NAME_RULE_LIMITS.matchesPerRule; match = regex.exec(text)) {
    if (match[0] === "") {
      // пустое совпадение не режет ничего, но и не должно зациклить поиск
      regex.lastIndex += 1;
      continue;
    }
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  regex.lastIndex = 0;
  return spans;
}

function spansOf(rule: CompiledRule, text: string, folded: string): Span[] {
  if (rule.regex !== null) return regexSpans(rule.regex, text);
  return phraseSpans(folded, rule.folded, rule.kind === "word");
}

const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;

function rulesOf(set: NameRuleSet, categories: readonly NameRuleCategory[]): readonly CompiledRule[] {
  const compiled = COMPILED.get(set);
  return compiled === undefined ? [] : compiled.filter((rule) => categories.includes(rule.category));
}

interface Candidate {
  ruleId: string;
  span: Span;
}

/** Совпадения правил этих категорий на тексте — в порядке применения. */
function candidates(set: NameRuleSet, categories: readonly NameRuleCategory[], text: string): Candidate[] {
  const folded = foldForRules(text);
  return rulesOf(set, categories).flatMap((rule) => spansOf(rule, text, folded).map((span) => ({ ruleId: rule.ruleId, span })));
}

/** Участки, которые правила `allow` берут под охрану, и id сработавших исключений. */
export function protectedSpans(set: NameRuleSet, text: string): { spans: Span[]; ids: string[] } {
  const found = candidates(set, ["allow"], text.slice(0, headLength(text)));
  return { spans: found.map((item) => item.span), ids: [...new Set(found.map((item) => item.ruleId))] };
}

/** Объединяет пересекающиеся участки; результат упорядочен по началу. */
function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && span.start < last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/** Каждый участок заменяется одним пробелом. */
export function maskSpans(text: string, spans: readonly Span[]): string {
  let result = "";
  let from = 0;
  for (const span of mergeSpans(spans)) {
    result += `${text.slice(from, span.start)} `;
    from = span.end;
  }
  return result + text.slice(from);
}

/**
 * Правила на нике. Сначала исключения, потом вырезание (участки, пересекающиеся
 * с исключением, не режутся), потом мат на тексте после вырезания.
 */
export function applyNameRules(set: NameRuleSet, name: string): RulesVerdict {
  const compiled = COMPILED.get(set);
  if (compiled === undefined || compiled.length === 0) return { text: name, profane: false, hits: [], saved: [] };
  const head = name.slice(0, headLength(name));
  const tail = name.slice(head.length);
  const saved = new Set<string>();
  const hits = new Set<string>();

  /** Совпадения, не задетые исключением; задетые отбрасываются, а исключение записывается как спасшее. */
  const unguarded = (found: readonly Candidate[], guards: readonly Candidate[]): Candidate[] =>
    found.filter((candidate) => {
      const blockers = guards.filter((guard) => overlaps(candidate.span, guard.span));
      for (const blocker of blockers) saved.add(blocker.ruleId);
      return blockers.length === 0;
    });

  // вырезание: участки, пересекающиеся с исключением, не режутся
  const cuts = unguarded(candidates(set, CUTTING, head), candidates(set, ["allow"], head));
  for (const cut of cuts) hits.add(cut.ruleId);
  const cutText = maskSpans(head, cuts.map((cut) => cut.span));

  // мат — по тексту после вырезания, с исключениями, пересчитанными на нём
  const profane = unguarded(candidates(set, ["profanity"], cutText), candidates(set, ["allow"], cutText));
  for (const word of profane) hits.add(word.ruleId);

  return { text: cutText + tail, profane: profane.length > 0, hits: [...hits], saved: [...saved] };
}

/** Совпадения одного правила на тексте — для окна «проверить на примерах». */
export function previewMatches(def: NameRuleDef, text: string): Span[] {
  const compiled = compileNameRules([def]);
  const head = text.slice(0, headLength(text));
  const rule = COMPILED.get(compiled)?.[0];
  return rule === undefined ? [] : spansOf(rule, head, foldForRules(head));
}
