import { stripLinksAndMentions } from "./display-name-links.js";
import { applyNameRules, EMPTY_NAME_RULES, maskSpans, protectedSpans, type NameRuleSet } from "../name-rules/name-rules-engine.js";
import { hasProfanity } from "./display-name-words.js";

/**
 * Чистка ника игрока (tasks/T-0149): имя с площадки видят все в рейтинге и
 * «Друзьях», поэтому знаки, которыми рисуют на полэкрана, и мат в нём не
 * нужны. Чистая функция: вход, база и панель — отдельные задачи.
 */
export type NameVerdict = "ok" | "trimmed" | "symbols" | "empty" | "profanity";

export interface CleanName {
  name: string;
  verdict: NameVerdict;
}

const MAX_GRAPHEMES = 24;
/** Склейка эмодзи: без неё семья и флаги распадаются на части. */
const ZERO_WIDTH_JOINER = "\u200d";
/** Выбор вида эмодзи — не надстрочный знак «залго», в счёт не идёт. */
const EMOJI_SELECTORS = new Set(["\ufe0f", "\ufe0e"]);
/** Больше трёх надстрочных знаков на букву не бывает ни в одной письменности, кроме «залго». */
const MAX_MARKS = 3;

/**
 * Блоки, из которых рисуют картинки шириной в строку: клинопись, египетские
 * иероглифы, лигатуры-слова, рамки и блоки, шрифт Брайля.
 */
function isWideDrawing(code: number): boolean {
  return (
    (code >= 0x12000 && code <= 0x1254f) ||
    (code >= 0x13000 && code <= 0x1345f) ||
    (code >= 0xfdfa && code <= 0xfdfd) ||
    (code >= 0x2500 && code <= 0x259f) ||
    (code >= 0x2800 && code <= 0x28ff)
  );
}

/** Управляющие, частные, неназначенные, охватывающие знаки и служебные, кроме склейки. */
const DROPPED = /^[\p{Cc}\p{Co}\p{Cn}\p{Me}]$/u;
const SERVICE = /^\p{Cf}$/u;
const MARK = /^\p{Mn}$/u;

function stripSymbols(text: string): string {
  let result = "";
  let marks = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === ZERO_WIDTH_JOINER) {
      result += char;
      continue;
    }
    if (DROPPED.test(char) || SERVICE.test(char) || isWideDrawing(code)) continue;
    if (MARK.test(char) && !EMOJI_SELECTORS.has(char)) {
      marks += 1;
      if (marks > MAX_MARKS) continue;
    } else if (!EMOJI_SELECTORS.has(char)) {
      marks = 0;
    }
    result += char;
  }
  return result;
}

function collapseSpaces(text: string): string {
  return text.replace(/[\p{Z}\s]+/gu, " ").trim();
}

function graphemes(text: string): string[] {
  return [...new Intl.Segmenter("ru", { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
}

/** Что чистка сделала с ником и какие правила из базы в этом участвовали. */
export interface NameCleanDetail {
  name: string | null;
  verdict: NameVerdict;
  /** id правил, которые вырезали часть ника или заменили его целиком */
  hits: string[];
  /** id исключений, которые спасли ник или его часть от правил и встроенного словаря */
  saved: string[];
}

function clean(raw: string, limit: boolean, rules: NameRuleSet): NameCleanDetail {
  // Равнозначная запись («e» + знак и «ê») изменением не считается.
  const original = collapseSpaces(raw.normalize("NFC"));
  // Табуляция и перевод строки — управляющие, но по смыслу пробелы.
  const spaced = raw.normalize("NFKC").replace(/[\t\n\r\v\f]/gu, " ");
  // Знаки считаются в разложенном виде: «o» с рожком из NFKC — буква с уже одним знаком.
  // Ссылки и упоминания — после чистки знаков (невидимый знак внутри «t.me» уже
  // ушёл, полноширинная запись свёрнута NFKC) и до проверки «нет букв» и обрезки.
  const stripped = collapseSpaces(stripLinksAndMentions(stripSymbols(spaced.normalize("NFD")).normalize("NFC")));
  // Правила из базы — после встроенной чистки знаков и ссылок, до проверки «нет букв»:
  // вырезанное правилом может оставить пустоту. Пустой набор ничего не меняет.
  const byRules = applyNameRules(rules, stripped);
  const name = collapseSpaces(byRules.text);
  const hits = byRules.hits;
  const saved = new Set(byRules.saved);
  if (!/[\p{L}\p{N}]/u.test(name)) return { name: null, verdict: "empty", hits, saved: [...saved] };
  // Встроенный мат первым; участки исключений маскируются, чтобы слово, которое словарь
  // считает матом, но команда разрешила, прошло.
  let builtIn = hasProfanity(name);
  if (builtIn) {
    const guard = protectedSpans(rules, name);
    if (guard.spans.length > 0 && !hasProfanity(maskSpans(name, guard.spans))) {
      builtIn = false;
      for (const id of guard.ids) saved.add(id);
    }
  }
  if (builtIn || byRules.profane) return { name: null, verdict: "profanity", hits, saved: [...saved] };
  const parts = graphemes(name);
  if (limit && parts.length > MAX_GRAPHEMES) {
    const cut = `${parts.slice(0, MAX_GRAPHEMES - 1).join("")}…`;
    return { name: cut, verdict: name === original ? "trimmed" : "symbols", hits, saved: [...saved] };
  }
  return { name, verdict: name === original ? "ok" : "symbols", hits, saved: [...saved] };
}

/** Чистый ник с подробностями для панели: какие правила сработали и что спасли исключения. */
export function cleanNameDetailed(raw: string, rules: NameRuleSet = EMPTY_NAME_RULES): NameCleanDetail {
  return clean(raw, true, rules);
}

/** Чистый ник; `name: null` — ника нет (пусто после чистки или мат). */
export function cleanName(raw: string, rules: NameRuleSet = EMPTY_NAME_RULES): { name: string | null; verdict: NameVerdict } {
  const { name, verdict } = clean(raw, true, rules);
  return { name, verdict };
}

/** Постоянный номер для аккаунта: разный у соседей в рейтинге, id площадки не светится. */
function fallbackName(accountId: string): string {
  const number = Number.parseInt(accountId.slice(0, 8), 16);
  return `Игрок ${String(Number.isNaN(number) ? 0 : number % 10_000).padStart(4, "0")}`;
}

/**
 * Ник для показа: очищенный, а если его нет — чистый username площадки, а
 * если и его нет — «Игрок NNNN». `verdict` — про исходный ник, `hits` и
 * `saved` — тоже про него: username в них не входит. Запасной ход чистится
 * теми же правилами, что и ник.
 */
export function displayNameDetailed(raw: string, username: string | null, accountId: string, rules: NameRuleSet = EMPTY_NAME_RULES): CleanName & { hits: string[]; saved: string[] } {
  const own = clean(raw, true, rules);
  if (own.name !== null) return { name: own.name, verdict: own.verdict, hits: own.hits, saved: own.saved };
  const handle = username === null ? null : clean(username.replace(/^@/u, ""), false, rules).name;
  return { name: handle ?? fallbackName(accountId), verdict: own.verdict, hits: own.hits, saved: own.saved };
}

export function displayNameFor(raw: string, username: string | null, accountId: string, rules: NameRuleSet = EMPTY_NAME_RULES): CleanName {
  const { name, verdict } = displayNameDetailed(raw, username, accountId, rules);
  return { name, verdict };
}
