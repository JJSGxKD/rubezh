import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod/mini";

/**
 * Обращение к игроку — на «ты» и без рода (решение владельца, Р163; правила —
 * `.claude/skills/ui-design/ux-writing.md` §1). Тест не даёт вернуть «вы»
 * новой строкой в словарях оболочки (T-0331).
 */

// `\b` в JavaScript не знает кириллицы, поэтому границы слова — через «не буква».
const ADDRESS_RE = /(?<!\p{L})(вы|вас|вам|вами|ваш\p{L}*)(?!\p{L})/giu;
const IMPERATIVE_RE = /(?<!\p{L})\p{L}+(ите|йте|ьте)(?!\p{L})/giu;

/**
 * Существительные, которые кончаются как повелительное «-ите»: в тексте они
 * обычные слова, а не обращение к игроку. Добавлять сюда только существительное
 * и с комментарием, зачем оно.
 */
const NOT_PLURAL_IMPERATIVE: ReadonlySet<string> = new Set([
  "элите", // «элите» — дательный падеж «элита»: «награда элите»
  "орбите", // «орбите» — предложный падеж «орбита»: «враг на орбите»
  "защите", // «защите» — дательный падеж «защита»: «по защите»
  "сайте", // «сайте» — предложный падеж «сайт»: «на сайте»
]);

/** Слова-нарушения в строке: местоимения «вы» и глаголы на «-ите» / «-йте» / «-ьте» вне исключений. */
function addressProblems(value: string): string[] {
  const words = [...value.matchAll(ADDRESS_RE)].map((match) => match[0]);
  for (const match of value.matchAll(IMPERATIVE_RE)) {
    const word = match[0];
    if (!NOT_PLURAL_IMPERATIVE.has(word.toLowerCase())) words.push(word);
  }
  return words;
}

const DICTIONARY_DIR = fileURLToPath(new URL("../src/i18n", import.meta.url));

function dictionaries(): Array<{ file: string; entries: Record<string, string> }> {
  return readdirSync(DICTIONARY_DIR)
    .filter((name) => /^ru.*\.json$/.test(name))
    .sort()
    .map((file) => ({
      file,
      entries: z.record(z.string(), z.string()).parse(JSON.parse(readFileSync(`${DICTIONARY_DIR}/${file}`, "utf8"))),
    }));
}

describe("обращение к игроку на «ты»", () => {
  it("ни одна строка словаря оболочки не говорит «вы» и не требует «-ите» / «-йте»", () => {
    const problems: string[] = [];
    for (const { file, entries } of dictionaries()) {
      for (const [key, value] of Object.entries(entries)) {
        for (const word of addressProblems(value)) problems.push(`${file} «${key}»: «${word}»`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("детектор ловит «Попробуйте позже»", () => {
    expect(addressProblems("Попробуйте позже")).toEqual(["Попробуйте"]);
    expect(addressProblems("Проверьте связь")).toEqual(["Проверьте"]);
  });

  it("детектор пропускает «Попробуй позже» и существительное «орбите»", () => {
    expect(addressProblems("Попробуй позже")).toEqual([]);
    expect(addressProblems("враг на орбите")).toEqual([]);
  });

  it("детектор ловит «вы», «ваш» и их формы, но не слова с этими буквами внутри", () => {
    expect(addressProblems("Вы пали")).toEqual(["Вы"]);
    expect(addressProblems("Это ваше устройство")).toEqual(["ваше"]);
    // «вывод», «навыки» — другие слова: «вы» в них не отдельное слово.
    expect(addressProblems("вывод навыки")).toEqual([]);
  });
});
