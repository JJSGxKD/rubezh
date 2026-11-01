import { describe, expect, it } from "vitest";
import { tokensOf } from "../src/modules/name-rules/name-rule-candidates-tokens.js";

/**
 * Разбор ника на слова и пары слов для кандидатов в правила имён (Р168,
 * tasks/T-0341): чистые функции. Слова нейтральные — списков в репозитории нет.
 */

describe("tokensOf", () => {
  it("слова и пары соседних слов; число из одних цифр отсеяно", () => {
    expect(tokensOf("Вася Пример-Бренд 2024")).toEqual({ words: ["вася", "пример", "бренд"], pairs: ["вася пример", "пример бренд"] });
  });

  it("регистр и «ё» свёрнуты: одинаковые слова — одно слово и ни одной пары", () => {
    expect(tokensOf("ЁЛКА Елка")).toEqual({ words: ["елка"], pairs: [] });
  });

  it("повтор в одном нике — слово один раз", () => {
    expect(tokensOf("пример пример пример")).toEqual({ words: ["пример"], pairs: [] });
  });

  it("повторяющаяся пара в одном нике — один раз", () => {
    expect(tokensOf("альфа бета альфа бета").pairs).toEqual(["альфа бета", "бета альфа"]);
  });

  it("длина слова — от 3 до 32 знаков; отброшенное слово разрывает пару", () => {
    const long = "а".repeat(33);
    expect(tokensOf(`ab ${long} abc`)).toEqual({ words: ["abc"], pairs: [] });
    expect(tokensOf("альфа бе гамма")).toEqual({ words: ["альфа", "гамма"], pairs: [] });
    expect(tokensOf(`альфа ${"б".repeat(32)}`).words).toHaveLength(2);
    expect(tokensOf("альфа бета гамма").pairs).toEqual(["альфа бета", "бета гамма"]);
  });

  it("берутся первые 12 слов", () => {
    const name = Array.from({ length: 15 }, (_, index) => `слово${String.fromCharCode(97 + index)}`).join(" ");
    const tokens = tokensOf(name);
    expect(tokens.words).toHaveLength(12);
    expect(tokens.words[11]).toBe("словоl");
    expect(tokens.pairs).toHaveLength(11);
  });

  it("ссылки и упоминания слов не дают", () => {
    expect(tokensOf("t.me/chan_name @someone пример")).toEqual({ words: ["пример"], pairs: [] });
  });

  it("предел цифр — 4: abc1234 принят, abc12345 отброшен; токен из одних цифр отброшен — в нём нет двух букв", () => {
    expect(tokensOf("abc1234").words).toEqual(["abc1234"]);
    expect(tokensOf("abc12345").words).toEqual([]);
    expect(tokensOf("2024").words).toEqual([]);
  });

  it("полноширинная запись сводится NFKC к обычной", () => {
    expect(tokensOf("ＰＲＩＭＥＲ").words).toEqual(["primer"]);
  });

  it("слово из одной буквы и цифр отброшено: нужно хотя бы две буквы", () => {
    expect(tokensOf("a123 пример").words).toEqual(["пример"]);
  });

  it("пустой и бессловесный ник — пусто", () => {
    expect(tokensOf("")).toEqual({ words: [], pairs: [] });
    expect(tokensOf("!!! ??? ...")).toEqual({ words: [], pairs: [] });
  });

  it("пара длиннее 64 знаков отбрасывается", () => {
    const left = "а".repeat(32);
    const right = "б".repeat(32);
    expect(tokensOf(`${left} ${right}`)).toEqual({ words: [left, right], pairs: [] });
    expect(tokensOf(`${"а".repeat(31)} ${"б".repeat(32)}`).pairs).toHaveLength(1);
  });
});
