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
const REPEAT = "Предел повтора — не больше 10";
const QUANTIFIERS = "Не больше шести повторов в шаблоне";
const EMPTY = "Регулярка совпадает с пустой строкой";
const SLOW = "Шаблон слишком медленный на длинных никах";

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
    ["a{11}", REPEAT],
    // «?» внутри группы — квантификатор для правила повтора группы
    ["(?:жж?)+ю", GROUP],
    ["(?:a?b)+", GROUP],
    ["(?:a??b)*", GROUP],
    ["(a(?:bc)?d)+", GROUP],
    // не больше шести квантификаторов любого вида
    [`${"ж?".repeat(30)}ж{20}ж{10}`, QUANTIFIERS],
    ["a?b?c?d?e?f?g?h", QUANTIFIERS],
    ["a{1}b{2}c{3}d{1,2}e?f+g*", QUANTIFIERS],
    [`${"a??".repeat(7)}b`, QUANTIFIERS],
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
    String.raw`a{10}`,
    String.raw`\u{1F600}x`,
    // «?» после «)» правило группы не включает
    "(?:a|b)?c",
    "(?:a?b|c)?x",
    "(х|x)(у|y)(й|и)",
    // ленивый суффикс — часть квантификатора, не новый: шесть квантификаторов
    `${"a??".repeat(6)}b`,
    "a+?b{2}?c",
    // ровно шесть квантификаторов
    "a?b?c?d?e?f?g",
  ])("%s", (pattern) => {
    expect(checkRegexSafety(pattern)).toEqual({ ok: true });
  });

  it("три повтора без предела — ещё можно, четыре — уже нет", () => {
    expect(checkRegexSafety("a+b+c+d")).toEqual({ ok: true });
    expect(checkRegexSafety("a+b+c+d+")).toEqual({ ok: false, reason: UNBOUNDED });
  });
});

describe("checkRegexSafety: подсчёт квантификаторов", () => {
  it("шесть — ещё можно, семь — уже нет", () => {
    expect(checkRegexSafety("a?b?c?d?e?f?g")).toEqual({ ok: true });
    expect(checkRegexSafety("a?b?c?d?e?f?g?h")).toEqual({ ok: false, reason: QUANTIFIERS });
  });

  it("знаки внутри класса и экранированные не считаются", () => {
    expect(checkRegexSafety(String.raw`[?*+]a\?b\+c\*d`)).toEqual({ ok: true });
  });

  it("«?» в начале группы — не квантификатор", () => {
    expect(checkRegexSafety("(?:a)(?:b)(?:c)(?:d)(?:e)(?:f)(?:g)(?<h>i)")).toEqual({ ok: true });
  });
});

describe("probeRegex", () => {
  it("быстрые часы — ok", () => {
    expect(probeRegex(String.raw`пример\d{2,4}`, () => 0)).toEqual({ ok: true });
  });

  it("часы, прибавляющие больше 2 мс за строку, — отказ «слишком медленный»", () => {
    let now = 0;
    const slow = () => {
      now += 30;
      return now;
    };
    expect(probeRegex("x+", slow)).toEqual({ ok: false, reason: SLOW });
  });

  it("ровно на пределе строки — ещё ok", () => {
    let now = 0;
    const edge = () => {
      now += 2;
      return now;
    };
    expect(probeRegex("x+", edge)).toEqual({ ok: true });
  });

  it("сумма по шаблону больше 30 мс — отказ, хотя каждая строка в пределе", () => {
    let now = 0;
    const edge = () => {
      now += 2;
      return now;
    };
    expect(probeRegex("a+b+c?d?e{0,2}f{1,3}g", edge)).toEqual({ ok: false, reason: SLOW });
  });

  it("настоящие часы: обычная регулярка проходит", () => {
    expect(probeRegex(String.raw`(?:free|пример)\s*(?:vpn|впн)`)).toEqual({ ok: true });
  });

  it("регулярка, которая не разбирается, не роняет прогон", () => {
    expect(probeRegex("(")).toEqual({ ok: false, reason: PARSE });
  });
});

describe("probeRegex: настоящие часы на «злых» формах", () => {
  // Каждую форму сначала пропускает сканер: отказывает именно прогон, и он не виснет.
  it.each([
    "ж{0,10}ж{0,10}ж{0,10}ж{0,10}ю",
    "ж+ж+ж+ю",
    "[бв]+[бв]+[бв]+г",
    "(?:а|б)?ж{0,10}ж{0,10}ж{0,10}ж{0,10}ж{0,10}ю",
    // соседние классы пересекаются на знаке, который не первый ни в одном из них
    "[бв]{0,10}[гв]{0,10}[бв]{0,10}[гв]{0,10}[бв]{0,10}[гв]{0,10}ю",
    "[бв]{0,10}[гв]{0,10}[бв]{0,10}[гв]{0,10}[бв]{0,10}ю",
    "[бв]+[гв]+[бв]+ю",
    "[бв]+[гв]+[бв]+[гв]{0,10}[бв]{0,10}[гв]{0,10}ю",
    // диапазоны пересекаются не на первом знаке
    "[а-д]+[г-к]+[в-е]+ю",
  ])(
    "%s",
    (pattern) => {
      expect(checkRegexSafety(pattern)).toEqual({ ok: true });
      const startedAt = performance.now();
      expect(probeRegex(pattern)).toEqual({ ok: false, reason: SLOW });
      expect(performance.now() - startedAt).toBeLessThan(1500);
    },
    2000,
  );
});

describe("probeRegex: разрешённые формы укладываются на всех длинах", () => {
  /** До трёх замеров: один может испортить пауза сборщика мусора. */
  const passes = (pattern: string): boolean => [0, 1, 2].some(() => probeRegex(pattern).ok);

  it.each(["х+у+й", "б+л+я+", "(х|x)(у|y)(й|и)", "админ.*", "х.{0,3}й", String.raw`^bot\d+$`, "(?:a|b)?x"])("%s", (pattern) => {
    expect(checkRegexSafety(pattern)).toEqual({ ok: true });
    expect(passes(pattern)).toBe(true);
  });
});
