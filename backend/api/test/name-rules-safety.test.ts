import { describe, expect, it } from "vitest";
import { checkRegexSafety, probeRegex } from "../src/modules/name-rules/name-rules-safety.js";

/**
 * Безопасное подмножество регулярок правил имён (tasks/T-0338, Р168):
 * регулярку присылает человек, а исполняется она на входе каждого игрока.
 */

const LENGTH = "Регулярка — от 1 до 100 знаков";
const PARSE = "Регулярка не разбирается";
const BACKREF = "Обратные ссылки не разрешены";
const LOOKAROUND = "Заглядывание вперёд и назад не разрешено";
const GROUP = "Повтор группы с повтором или выбором внутри не разрешён";
const UNBOUNDED = "Не больше трёх повторов без предела";
const REPEAT = "Предел повтора — не больше 20";
const EMPTY = "Регулярка совпадает с пустой строкой";
const SLOW = "Регулярка слишком медленная на длинных строках";

describe("checkRegexSafety: отказы", () => {
  it.each([
    ["a".repeat(101), LENGTH],
    ["", LENGTH],
    ["(", PARSE],
    ["[а-", PARSE],
    ["(a+)+", GROUP],
    ["(a|aa)*", GROUP],
    ["(.*)*", GROUP],
    [String.raw`(\w+\s?)+`, GROUP],
    ["(?:a|b)+", GROUP],
    ["((a)+)+", GROUP],
    ["(?:a{2}){3}", GROUP],
    [String.raw`\1`, BACKREF],
    [String.raw`(a)\1`, BACKREF],
    [String.raw`\k<n>`, BACKREF],
    [String.raw`(?<n>a)\k<n>`, BACKREF],
    ["(?=a)", LOOKAROUND],
    ["(?!a)", LOOKAROUND],
    ["(?<=a)b", LOOKAROUND],
    ["(?<!a)b", LOOKAROUND],
    ["a*a*a*a*", UNBOUNDED],
    ["a+b{2,}c*d+", UNBOUNDED],
    ["a{30}", REPEAT],
    ["a{1,30}", REPEAT],
    ["a*", EMPTY],
    ["^$", EMPTY],
  ])("%s", (pattern, reason) => {
    expect(checkRegexSafety(pattern)).toEqual({ ok: false, reason });
  });
});

describe("checkRegexSafety: принятые", () => {
  it.each([
    String.raw`пример\d{2,4}`,
    String.raw`(?:free|пример)\s*(?:vpn|впн)`,
    "[а-я]{3}-shop",
    String.raw`(?<год>\d{4})`,
    "x(?:a|b)?",
    // квантификаторы и скобки внутри класса буквальные
    "[+*]{1,3}x",
    "[(|)]x",
    String.raw`\p{L}{3,5}x`,
    String.raw`\(x\)+`,
    "x|y",
    String.raw`a{20}`,
    String.raw`\u{1F600}x`,
  ])("%s", (pattern) => {
    expect(checkRegexSafety(pattern)).toEqual({ ok: true });
  });

  it("три повтора без предела — ещё можно, четыре — уже нет", () => {
    expect(checkRegexSafety("a+b+c+d")).toEqual({ ok: true });
    expect(checkRegexSafety("a+b+c+d+")).toEqual({ ok: false, reason: UNBOUNDED });
  });
});

describe("probeRegex", () => {
  it("быстрые часы — ok", () => {
    expect(probeRegex(String.raw`пример\d{2,4}`, () => 0)).toEqual({ ok: true });
  });

  it("часы, прибавляющие больше 25 мс за прогон, — отказ «слишком медленная»", () => {
    let now = 0;
    const slow = () => {
      now += 30;
      return now;
    };
    expect(probeRegex("x+", slow)).toEqual({ ok: false, reason: SLOW });
  });

  it("ровно на пределе — ещё ok", () => {
    let now = 0;
    const edge = () => {
      now += 25;
      return now;
    };
    expect(probeRegex("x+", edge)).toEqual({ ok: true });
  });

  it("настоящие часы: обычная регулярка проходит", () => {
    expect(probeRegex(String.raw`(?:free|пример)\s*(?:vpn|впн)`)).toEqual({ ok: true });
  });

  it("регулярка, которая не разбирается, не роняет прогон", () => {
    expect(probeRegex("(")).toEqual({ ok: false, reason: PARSE });
  });
});
