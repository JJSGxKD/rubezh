import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyNameRules,
  compileNameRules,
  EMPTY_NAME_RULES,
  foldForRules,
  maskSpans,
  previewMatches,
  protectedSpans,
  type NameRuleDef,
} from "../src/modules/name-rules/name-rules-engine.js";
import type { NameRuleCategory, NameRuleKind } from "../src/modules/name-rules/name-rules-limits.js";
import { cleanName, cleanNameDetailed, displayNameFor } from "../src/modules/auth/display-name.js";

/**
 * Движок правил фильтра имён (tasks/T-0338, Р168): чистые функции без базы.
 * Слова в примерах нейтральные; мат берётся из test/display-name.test.ts —
 * в новых тестах он не пишется.
 */

const ACCOUNT = "a1b2c3d4-0000-4000-8000-000000000000";
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const def = (n: number, category: NameRuleCategory, kind: NameRuleKind, pattern: string): NameRuleDef => ({ ruleId: id(n), category, kind, pattern });
const rules = (...defs: NameRuleDef[]) => compileNameRules(defs);

const WORDS_TEST = readFileSync(new URL("./display-name.test.ts", import.meta.url), "utf8");

/** Массив строк из it.each(...) файла со словарными тестами — по подписи теста. */
function samplesOf(label: string): string[] {
  const pattern = new RegExp(String.raw`it\.each\((\[[^\]]*\])\)\("${label}"`, "u");
  const found = pattern.exec(WORDS_TEST)?.[1];
  if (found === undefined) throw new Error(`в display-name.test.ts нет массива «${label}»`);
  return JSON.parse(found) as string[];
}

function everySample(): string[] {
  const result: string[] = [];
  for (const match of WORDS_TEST.matchAll(/it\.each\((\[[^\]]*\])\)/gu)) {
    try {
      result.push(...(JSON.parse(match[1] ?? "[]") as string[]));
    } catch {
      // массив не из строк (числа, объекты) — не наш
    }
  }
  return result;
}

describe("вырезание: brand, ads, other", () => {
  it("точная фраза режется где угодно, вердикт symbols, hits называет правило", () => {
    const set = rules(def(1, "brand", "exact", "пример-бренд"));
    expect(cleanNameDetailed("Вася пример-бренд", set)).toEqual({ name: "Вася", verdict: "symbols", hits: [id(1)], saved: [] });
    expect(cleanNameDetailed("Вася", set)).toEqual({ name: "Вася", verdict: "ok", hits: [], saved: [] });
  });

  it("регистр и «ё» не мешают: «Ёлка Шоп» режет «Мир ЕЛКА ШОП»", () => {
    const set = rules(def(1, "brand", "exact", "Ёлка Шоп"));
    expect(cleanName("Мир ЕЛКА ШОП", set)).toEqual({ name: "Мир", verdict: "symbols" });
  });

  it("слово целиком: «Бренд Вася» режется, «Брендовый» и «Вася_бренд» — нет, дефис — граница", () => {
    const set = rules(def(1, "brand", "word", "бренд"));
    expect(cleanName("Бренд Вася", set).name).toBe("Вася");
    expect(cleanName("Брендовый", set)).toEqual({ name: "Брендовый", verdict: "ok" });
    expect(cleanName("Вася_бренд", set)).toEqual({ name: "Вася_бренд", verdict: "ok" });
    expect(cleanName("Вася-бренд", set).name).toBe("Вася-");
  });

  it("слово после неудачного вхождения ищется дальше: «Брендовый бренд»", () => {
    const set = rules(def(1, "brand", "word", "бренд"));
    expect(cleanName("Брендовый бренд", set).name).toBe("Брендовый");
  });

  it("регулярка работает по исходной строке: пример\\d{2,4} режет «пример2024», «пример5» остаётся", () => {
    const set = rules(def(1, "ads", "regex", String.raw`пример\d{2,4}`));
    expect(cleanName("Вася пример2024", set).name).toBe("Вася");
    expect(cleanName("Вася пример5", set).name).toBe("Вася пример5");
  });

  it("в регулярке «ё» и «е» — разные буквы, регистр не важен", () => {
    const set = rules(def(1, "other", "regex", "ёлка"));
    expect(cleanName("Вася ЁЛКА", set).name).toBe("Вася");
    expect(cleanName("Вася елка", set).name).toBe("Вася елка");
  });

  it("два правила режут два участка; пересекающиеся участки объединяются", () => {
    const two = rules(def(1, "brand", "exact", "пример-один"), def(2, "ads", "exact", "пример-два"));
    expect(cleanNameDetailed("пример-один Вася пример-два", two)).toMatchObject({ name: "Вася", hits: [id(1), id(2)] });

    const overlap = rules(def(1, "brand", "exact", "аа бб"), def(2, "brand", "exact", "бб вв"));
    expect(applyNameRules(overlap, "х аа бб вв у").text).toBe("х   у");
    expect(cleanName("х аа бб вв у", overlap).name).toBe("х у");
  });

  it("порядок правил во входном массиве на результат не влияет", () => {
    const defs = [
      def(1, "brand", "exact", "аа бб"),
      def(2, "ads", "word", "бб"),
      def(3, "other", "regex", "вв+"),
      def(4, "allow", "exact", "вв вв"),
      def(5, "profanity", "exact", "примерслово"),
    ];
    const names = ["х аа бб вв у", "бб вв вв вв", "Вася примерслово", "пусто"];
    const expected = names.map((name) => cleanNameDetailed(name, compileNameRules(defs)));
    const permutations = [[...defs].reverse(), [defs[2]!, defs[4]!, defs[0]!, defs[3]!, defs[1]!], [defs[3]!, defs[1]!, defs[4]!, defs[2]!, defs[0]!]];
    for (const permutation of permutations) {
      const set = compileNameRules(permutation);
      expect(names.map((name) => cleanNameDetailed(name, set))).toEqual(expected);
      expect(set.signature).toBe(compileNameRules(defs).signature);
    }
  });

  it("applyNameRules отдаёт текст с пробелом на месте участка (пробелы не свёрнуты)", () => {
    const verdict = applyNameRules(rules(def(1, "brand", "exact", "пример-бренд")), "Вася пример-бренд");
    expect(verdict).toEqual({ text: "Вася  ", profane: false, hits: [id(1)], saved: [] });
  });

  it("вырезано всё — ника нет, вердикт empty; запасной ход чистится теми же правилами", () => {
    const set = rules(def(1, "brand", "exact", "пример-бренд"));
    expect(cleanNameDetailed("пример-бренд", set)).toMatchObject({ name: null, verdict: "empty", hits: [id(1)] });
    expect(displayNameFor("пример-бренд", "vasya", ACCOUNT, set)).toEqual({ name: "vasya", verdict: "empty" });
    expect(displayNameFor("пример-бренд", "@пример-бренд", ACCOUNT, set).name).toMatch(/^Игрок \d{4}$/u);
    expect(displayNameFor("пример-бренд", null, ACCOUNT, set).name).toMatch(/^Игрок \d{4}$/u);
  });
});

describe("profanity заменяет ник целиком", () => {
  const set = rules(def(1, "profanity", "exact", "примерслово"));

  it("ник → username → «Игрок NNNN», вердикт profanity", () => {
    expect(cleanNameDetailed("Вася примерслово", set)).toEqual({ name: null, verdict: "profanity", hits: [id(1)], saved: [] });
    expect(displayNameFor("Вася примерслово", "vasya", ACCOUNT, set)).toEqual({ name: "vasya", verdict: "profanity" });
    expect(displayNameFor("Вася примерслово", null, ACCOUNT, set).name).toMatch(/^Игрок \d{4}$/u);
  });

  it("правило ищется и в username: матерный username не выручает", () => {
    expect(displayNameFor("Вася примерслово", "примерслово", ACCOUNT, set).name).toMatch(/^Игрок \d{4}$/u);
  });

  it("правило мата смотрит на текст после вырезания, а не на исходный", () => {
    const both = rules(def(1, "profanity", "exact", "примерслово"), def(2, "brand", "exact", "пример-бренд"));
    // между «пример» и «слово» после вырезания стоит пробел — слово не склеивается
    expect(cleanName("пример пример-бренд слово", both).verdict).not.toBe("profanity");
    expect(cleanName("примерслово пример-бренд", both).verdict).toBe("profanity");
  });
});

describe("allow: исключения", () => {
  it("исключение не даёт правилу вырезания сработать на своём участке", () => {
    const defs = [def(1, "brand", "exact", "пример"), def(2, "allow", "exact", "пример-бренд-два")];
    expect(cleanNameDetailed("Вася пример-бренд-два", compileNameRules(defs))).toEqual({ name: "Вася пример-бренд-два", verdict: "ok", hits: [], saved: [id(2)] });
    expect(cleanNameDetailed("Вася пример-бренд-два", rules(defs[0]!))).toMatchObject({ name: "Вася -бренд-два", verdict: "symbols", hits: [id(1)] });
  });

  it("вне исключения правило работает по-прежнему", () => {
    const set = rules(def(1, "brand", "exact", "пример"), def(2, "allow", "exact", "пример-бренд-два"));
    expect(cleanName("пример Вася пример-бренд-два", set).name).toBe("Вася пример-бренд-два");
  });

  it("исключение спасает и от profanity-правила", () => {
    const set = rules(def(1, "profanity", "exact", "примерслово"), def(2, "allow", "exact", "примерслово-мира"));
    expect(cleanNameDetailed("Вася примерслово-мира", set)).toMatchObject({ verdict: "ok", saved: [id(2)], hits: [] });
    expect(cleanName("Вася примерслово", set).verdict).toBe("profanity");
  });

  it("исключение против встроенного словаря: строка, которую словарь считает матом, проходит; сосед с тем же корнем — нет", () => {
    const adjacent = samplesOf("%s — мат");
    const allowed = adjacent.find((name) => name === "Night_Nigger");
    const neighbour = adjacent.find((name) => name === "nightnigga");
    if (allowed === undefined || neighbour === undefined) throw new Error("в display-name.test.ts изменились строки секции «мат рядом с исключением»");
    expect(cleanName(allowed).verdict).toBe("profanity");

    const set = rules(def(1, "allow", "exact", allowed));
    expect(cleanNameDetailed(allowed, set)).toEqual({ name: allowed, verdict: "ok", hits: [], saved: [id(1)] });
    expect(cleanName(neighbour, set).verdict).toBe("profanity");
  });
});

describe("пустой набор не меняет ничего", () => {
  const samples = [...new Set([...everySample(), "Вася", "Вася пример-бренд", "҉҉"])];

  it("строки из display-name.test.ts дают тот же результат с EMPTY_NAME_RULES и без набора", () => {
    expect(samples.length).toBeGreaterThan(40);
    for (const sample of samples) {
      expect(cleanName(sample, EMPTY_NAME_RULES), sample).toEqual(cleanName(sample));
      expect(displayNameFor(sample, "tolik", ACCOUNT, EMPTY_NAME_RULES), sample).toEqual(displayNameFor(sample, "tolik", ACCOUNT));
      expect(cleanNameDetailed(sample), sample).toMatchObject({ hits: [], saved: [] });
    }
  });

  it("набор, собранный из пустого списка, — тоже пустой", () => {
    const empty = compileNameRules([]);
    expect(empty.size).toBe(0);
    for (const sample of samples) expect(cleanName(sample, empty), sample).toEqual(cleanName(sample));
    expect(EMPTY_NAME_RULES).toMatchObject({ size: 0, signature: "" });
  });

  it("длинный ник без правил обрезается как раньше", () => {
    expect(cleanName("Абвгде".repeat(5), EMPTY_NAME_RULES)).toEqual(cleanName("Абвгде".repeat(5)));
  });
});

describe("compileNameRules", () => {
  it("плохие определения пропускаются с причиной, годные работают", () => {
    const bad: string[] = [];
    const set = compileNameRules(
      [def(1, "ads", "regex", "("), def(2, "ads", "regex", "a*"), def(3, "ads", "regex", "(a+)+"), def(4, "brand", "exact", "пример-бренд"), def(5, "ads", "regex", "пример\\d+")],
      (rule, reason) => bad.push(`${rule.ruleId}:${reason}`),
    );
    expect(set.size).toBe(2);
    expect(bad).toHaveLength(3);
    expect(bad.map((line) => line.slice(0, 36))).toEqual([id(1), id(2), id(3)]);
    expect(bad.every((line) => line.length > 40)).toBe(true);
    expect(cleanName("Вася пример-бренд пример12", set).name).toBe("Вася");
  });

  it("пустой шаблон точной фразы и слова — плохое определение", () => {
    const bad: string[] = [];
    const set = compileNameRules([def(1, "brand", "exact", ""), def(2, "brand", "word", "")], (rule) => bad.push(rule.ruleId));
    expect(set.size).toBe(0);
    expect(bad).toEqual([id(1), id(2)]);
  });

  it("подпись одинакова при перестановке входа и меняется при смене шаблона, категории и вида", () => {
    const a = def(1, "brand", "exact", "пример-бренд");
    const b = def(2, "ads", "word", "реклама");
    const base = compileNameRules([a, b]).signature;
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
    expect(compileNameRules([b, a]).signature).toBe(base);
    expect(compileNameRules([{ ...a, pattern: "пример-бренд-два" }, b]).signature).not.toBe(base);
    expect(compileNameRules([{ ...a, category: "other" }, b]).signature).not.toBe(base);
    expect(compileNameRules([{ ...a, kind: "word" }, b]).signature).not.toBe(base);
    expect(compileNameRules([a]).signature).not.toBe(base);
  });
});

describe("вспомогательные функции движка", () => {
  it("foldForRules: регистр и «ё», длина строки не меняется", () => {
    expect(foldForRules("ЁлКа Ёё")).toBe("елка ее");
    // «İ» при понижении регистра дала бы два знака — остаётся как есть, иначе поехали бы индексы
    for (const text of ["İstanbul", "Ǆ", "ẞtraße", "😀Ёж"]) expect(foldForRules(text).length, text).toBe(text.length);
  });

  it("protectedSpans и maskSpans: участок исключения → один пробел", () => {
    const set = rules(def(1, "allow", "exact", "пример-бренд"), def(2, "brand", "exact", "реклама"));
    const found = protectedSpans(set, "а пример-бренд б");
    expect(found).toEqual({ spans: [{ start: 2, end: 14 }], ids: [id(1)] });
    expect(maskSpans("а пример-бренд б", found.spans)).toBe("а   б");
    expect(protectedSpans(EMPTY_NAME_RULES, "что угодно")).toEqual({ spans: [], ids: [] });
  });

  it("previewMatches: совпадения одного правила, пустые совпадения регулярки пропущены", () => {
    expect(previewMatches(def(1, "brand", "exact", "аб"), "АБ аб Аб")).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
      { start: 6, end: 8 },
    ]);
    expect(previewMatches(def(1, "ads", "regex", "x+"), "axb")).toEqual([{ start: 1, end: 2 }]);
    expect(previewMatches(def(1, "ads", "regex", String.raw`\b`), "ab")).toEqual([]);
    expect(previewMatches(def(1, "ads", "regex", "("), "abc")).toEqual([]);
  });
});

describe("лимиты и детерминизм", () => {
  it("ник в 600 знаков с совпадением на позиции 550 не роняет чистку, результат — до 24 графем", () => {
    const set = rules(def(1, "brand", "exact", "пример-бренд"));
    const raw = `${"а".repeat(550)}пример-бренд${"б".repeat(38)}`;
    expect(raw).toHaveLength(600);
    const result = cleanName(raw, set);
    expect(result.name).not.toBeNull();
    expect([...new Intl.Segmenter("ru", { granularity: "grapheme" }).segment(result.name ?? "")].length).toBeLessThanOrEqual(24);
    expect(result.verdict).toBe("trimmed");
  });

  it("правила смотрят только первые 128 знаков", () => {
    const set = rules(def(1, "brand", "exact", "пример-бренд"));
    const verdict = applyNameRules(set, `${"а".repeat(200)}пример-бренд`);
    expect(verdict.hits).toEqual([]);
    expect(verdict.text).toBe(`${"а".repeat(200)}пример-бренд`);
  });

  it("граница 128 знаков не разрывает суррогатную пару", () => {
    const set = rules(def(1, "brand", "exact", "пример-бренд"));
    const text = `${"а".repeat(127)}😀хвост`;
    expect(applyNameRules(set, text).text).toBe(text);
  });

  it("регулярка с 30 совпадениями режет не больше 20", () => {
    const set = rules(def(1, "ads", "regex", "ab"));
    const text = "ab ".repeat(30).trim();
    const left = applyNameRules(set, text).text.match(/ab/gu)?.length ?? 0;
    expect(left).toBe(10);
  });

  it("одинаковый вход и набор дают одинаковый результат при повторном вызове", () => {
    const set = rules(def(1, "brand", "word", "бренд"), def(2, "ads", "regex", String.raw`пример\d+`), def(3, "profanity", "exact", "примерслово"));
    for (const sample of ["Бренд Вася пример12", "Вася", "примерслово", "҉ Оля"]) {
      expect(cleanNameDetailed(sample, set)).toEqual(cleanNameDetailed(sample, set));
    }
  });
});
