import { stripLinksAndMentions } from "../auth/display-name-links.js";
import { CANDIDATE_RULES } from "./name-rule-candidates-rules.js";
import { foldForRules } from "./name-rules-engine.js";

/**
 * Разбор ника на слова и пары слов для кандидатов в правила имён (Р168,
 * tasks/T-0341): чистая функция без базы. Ники не сохраняются — отсюда выходят
 * только слова, и считает их вызывающий.
 */

export interface NameTokens {
  /** слова ника без повторов, в порядке появления */
  words: string[];
  /** пары соседних принятых слов, `слово слово`, без повторов */
  pairs: string[];
}

const SPLIT = /[^\p{L}\p{N}]+/u;
const LETTER = /\p{L}/gu;
const DIGIT = /\p{N}/gu;

/** Слово годится: нужной длины, хотя бы две буквы, цифр не больше предела. */
function accepted(word: string): boolean {
  const length = [...word].length;
  if (length < CANDIDATE_RULES.tokenMin || length > CANDIDATE_RULES.tokenMax) return false;
  if ((word.match(LETTER) ?? []).length < 2) return false;
  return (word.match(DIGIT) ?? []).length <= CANDIDATE_RULES.digitsMax;
}

export function tokensOf(name: string): NameTokens {
  const folded = foldForRules(stripLinksAndMentions(name.normalize("NFKC")));
  // Соседними считаются только подряд идущие принятые слова: отброшенное разрывает пару.
  const taken: (string | null)[] = [];
  let count = 0;
  for (const part of folded.split(SPLIT)) {
    if (part === "") continue;
    if (!accepted(part)) {
      taken.push(null);
      continue;
    }
    // Дальше первых слов хвост ника не разбирается.
    if (count === CANDIDATE_RULES.wordsPerName) break;
    taken.push(part);
    count += 1;
  }

  const words = new Set<string>();
  const pairs = new Set<string>();
  taken.forEach((word, index) => {
    if (word === null) return;
    words.add(word);
    const next = taken[index + 1];
    if (next === undefined || next === null || next === word) return;
    const pair = `${word} ${next}`;
    if ([...pair].length <= CANDIDATE_RULES.pairMax) pairs.add(pair);
  });
  return { words: [...words], pairs: [...pairs] };
}
