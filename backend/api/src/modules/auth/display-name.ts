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

function clean(raw: string, limit: boolean): { name: string | null; verdict: NameVerdict } {
  // Равнозначная запись («e» + знак и «ê») изменением не считается.
  const original = collapseSpaces(raw.normalize("NFC"));
  // Табуляция и перевод строки — управляющие, но по смыслу пробелы.
  const spaced = raw.normalize("NFKC").replace(/[\t\n\r\v\f]/gu, " ");
  // Знаки считаются в разложенном виде: «o» с рожком из NFKC — буква с уже одним знаком.
  const name = collapseSpaces(stripSymbols(spaced.normalize("NFD")).normalize("NFC"));
  if (!/[\p{L}\p{N}]/u.test(name)) return { name: null, verdict: "empty" };
  if (hasProfanity(name)) return { name: null, verdict: "profanity" };
  const parts = graphemes(name);
  if (limit && parts.length > MAX_GRAPHEMES) {
    const cut = `${parts.slice(0, MAX_GRAPHEMES - 1).join("")}…`;
    return { name: cut, verdict: name === original ? "trimmed" : "symbols" };
  }
  return { name, verdict: name === original ? "ok" : "symbols" };
}

/** Чистый ник; `name: null` — ника нет (пусто после чистки или мат). */
export function cleanName(raw: string): { name: string | null; verdict: NameVerdict } {
  return clean(raw, true);
}

/** Постоянный номер для аккаунта: разный у соседей в рейтинге, id площадки не светится. */
function fallbackName(accountId: string): string {
  const number = Number.parseInt(accountId.slice(0, 8), 16);
  return `Игрок ${String(Number.isNaN(number) ? 0 : number % 10_000).padStart(4, "0")}`;
}

/**
 * Ник для показа: очищенный, а если его нет — чистый username площадки, а
 * если и его нет — «Игрок NNNN». `verdict` — про исходный ник.
 */
export function displayNameFor(raw: string, username: string | null, accountId: string): CleanName {
  const own = clean(raw, true);
  if (own.name !== null) return { name: own.name, verdict: own.verdict };
  const handle = username === null ? null : clean(username.replace(/^@/u, ""), false).name;
  return { name: handle ?? fallbackName(accountId), verdict: own.verdict };
}
