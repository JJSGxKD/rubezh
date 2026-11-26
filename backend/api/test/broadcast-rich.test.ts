import { describe, expect, it } from "vitest";
import { BROADCAST_RICH_LIMITS, editionHash, parseBroadcastMarkdown } from "../src/modules/broadcasts/broadcast-rich.js";
import { plainTextOf, richProblems, type RichBlock, type RichDocument, type RichText } from "../src/platforms/ports/rich-message.js";

/**
 * Ограниченный Markdown рассылок (tasks/T-0403, Р199): разбор в `RichDocument`,
 * ошибки с номером строки и отпечаток редакции. Разбор — чистая функция, поэтому
 * тест без базы, Nest и настроек: всё, что приходит из панели, — недоверенный текст.
 */

/** Блоки текста, в котором ошибок быть не должно. */
function blocksOf(source: string): readonly RichBlock[] {
  const parsed = parseBroadcastMarkdown(source);
  expect(parsed.problems).toEqual([]);
  return parsed.doc.blocks;
}

const problemsOf = (source: string): string[] => parseBroadcastMarkdown(source).problems;

/** Один абзац текста — его содержимое для проверки инлайна. */
function inlineOf(source: string): RichText {
  const [block, ...rest] = blocksOf(source);
  expect(rest).toEqual([]);
  expect(block?.kind).toBe("paragraph");
  return (block as Extract<RichBlock, { kind: "paragraph" }>).text;
}

const TABLE = ["| Враг | Урон |", "|---|---|", "| Крыса | 4 |", "| Волк | 7 |"].join("\n");

describe("блоки: каждая строка таблицы разбора", () => {
  it("заголовки #, ## и ### — heading с уровнем; # без пробела — просто текст", () => {
    expect(blocksOf("# Один\n\n## Два\n\n### Три")).toEqual([
      { kind: "heading", level: 1, text: "Один" },
      { kind: "heading", level: 2, text: "Два" },
      { kind: "heading", level: 3, text: "Три" },
    ]);
    expect(blocksOf("#хэштег и #1 в рейтинге")).toEqual([{ kind: "paragraph", text: "#хэштег и #1 в рейтинге" }]);
  });

  it("заголовок глубже третьего уровня и пустой — ошибка с номером строки", () => {
    expect(problemsOf("Текст\n\n#### Четыре")).toEqual(["строка 3: заголовки бывают трёх уровней: #, ## и ###"]);
    expect(problemsOf("##")).toEqual(["строка 1: пустой заголовок"]);
  });

  it("строки «- » и «* » подряд — маркированный список, ordered нет вовсе", () => {
    const [list] = blocksOf("- один\n* два\n- три");
    expect(list).toEqual({ kind: "list", items: ["один", "два", "три"] });
    expect("ordered" in (list ?? {})).toBe(false);
  });

  it("строки «1. », «2. » подряд — нумерованный список", () => {
    expect(blocksOf("1. первое\n2. второе\n3. третье")).toEqual([{ kind: "list", ordered: true, items: ["первое", "второе", "третье"] }]);
  });

  it("нумерация идёт подряд с единицы; число в начале абзаца — не список", () => {
    expect(problemsOf("1. а\n3. б")).toEqual(["строка 2: нумерация списка должна идти подряд — ожидалось 2"]);
    expect(problemsOf("1. а\n1. б")).toEqual(["строка 2: нумерация списка должна идти подряд — ожидалось 2"]);
    expect(blocksOf("15. ноября выходит обновление")).toEqual([{ kind: "paragraph", text: "15. ноября выходит обновление" }]);
    expect(blocksOf("2. второй без первого")).toEqual([{ kind: "paragraph", text: "2. второй без первого" }]);
  });

  it("пустой пункт — ошибка; «-5 градусов» и «**жирный**» в начале строки — не списки", () => {
    expect(problemsOf("- один\n-")).toEqual(["строка 2: пустой пункт списка"]);
    expect(blocksOf("-5 градусов")).toEqual([{ kind: "paragraph", text: "-5 градусов" }]);
    expect(blocksOf("**жирный** в начале")[0]).toMatchObject({ kind: "paragraph" });
  });

  it("строки «> » подряд — цитата, строки через перевод строки", () => {
    expect(blocksOf("> раз\n> два")).toEqual([{ kind: "quote", text: "раз\nдва" }]);
  });

  it("таблица: первая строка — header, вторая — разделитель, ячейки обрезаются", () => {
    expect(blocksOf(TABLE)).toEqual([
      {
        kind: "table",
        header: ["Враг", "Урон"],
        rows: [
          ["Крыса", "4"],
          ["Волк", "7"],
        ],
      },
    ]);
    expect(blocksOf("|   а   |б|\n|---|---|\n||  |")).toEqual([{ kind: "table", header: ["а", "б"], rows: [["", ""]] }]);
  });

  it("в ячейке: инлайн-разметка и экранированная черта", () => {
    expect(blocksOf("| **А** | б \\| в |\n|---|---|")).toEqual([{ kind: "table", header: [{ kind: "bold", text: "А" }, "б | в"], rows: [] }]);
  });

  it("<details> и <summary> на своих строках — раскрывающийся блок, внутри те же правила", () => {
    const source = ["<details>", "<summary>Подробнее</summary>", "", "Текст внутри", "", TABLE, "</details>"].join("\n");
    expect(blocksOf(source)).toEqual([
      {
        kind: "details",
        summary: "Подробнее",
        blocks: [
          { kind: "paragraph", text: "Текст внутри" },
          {
            kind: "table",
            header: ["Враг", "Урон"],
            rows: [
              ["Крыса", "4"],
              ["Волк", "7"],
            ],
          },
        ],
      },
    ]);
  });

  it("в заголовке <summary> — инлайн; отступ перед тегом допустим", () => {
    const source = "  <details>\n  <summary>**Важно** знать</summary>\n- пункт\n  </details>";
    expect(blocksOf(source)).toEqual([{ kind: "details", summary: [{ kind: "bold", text: "Важно" }, " знать"], blocks: [{ kind: "list", items: ["пункт"] }] }]);
  });

  it("--- одна в строке — разделитель", () => {
    expect(blocksOf("до\n\n---\n\nпосле")).toEqual([{ kind: "paragraph", text: "до" }, { kind: "divider" }, { kind: "paragraph", text: "после" }]);
  });

  it("прочие строки подряд — абзац со строками через перевод строки; отступ обрезается", () => {
    expect(blocksOf("раз\n  два\nтри")).toEqual([{ kind: "paragraph", text: "раз\nдва\nтри" }]);
  });

  it("блоки разделяет пустая строка, но смена вида строки тоже начинает новый блок", () => {
    expect(blocksOf("# Заголовок\nтекст\n- пункт\n> цитата\n\n\n\nконец")).toEqual([
      { kind: "heading", level: 1, text: "Заголовок" },
      { kind: "paragraph", text: "текст" },
      { kind: "list", items: ["пункт"] },
      { kind: "quote", text: "цитата" },
      { kind: "paragraph", text: "конец" },
    ]);
  });

  it("отступ перед разметкой — ошибка, а не молчаливо плоский список", () => {
    expect(problemsOf("- а\n  - вложенный")).toEqual(["строка 2: отступ перед разметкой не поддерживается — вложенных списков и цитат нет"]);
  });

  it("перевод строки \\r\\n и одиночный \\r разбираются как \\n", () => {
    const lf = "# А\n\n- б\n- в\n\n" + TABLE;
    expect(parseBroadcastMarkdown(lf.replaceAll("\n", "\r\n"))).toEqual(parseBroadcastMarkdown(lf));
    expect(parseBroadcastMarkdown(lf.replaceAll("\n", "\r"))).toEqual(parseBroadcastMarkdown(lf));
  });
});

describe("инлайн-разметка", () => {
  it("**жирный**, _курсив_ и [ссылка](https://…) — три вида частей", () => {
    expect(inlineOf("**жирный** и _курсив_ [сайт](https://t.me/x)")).toEqual([
      { kind: "bold", text: "жирный" },
      " и ",
      { kind: "italic", text: "курсив" },
      " ",
      { kind: "link", text: "сайт", url: "https://t.me/x" },
    ]);
  });

  it("вложенные **_…_** допустимы, ссылка может нести жирный", () => {
    expect(inlineOf("**_оба_**")).toEqual({ kind: "bold", text: { kind: "italic", text: "оба" } });
    expect(inlineOf("_**оба**_")).toEqual({ kind: "italic", text: { kind: "bold", text: "оба" } });
    expect(inlineOf("[**тут**](https://t.me/x)")).toEqual({ kind: "link", text: { kind: "bold", text: "тут" }, url: "https://t.me/x" });
    expect(inlineOf("**до [ссылка](https://t.me/x) после**")).toEqual({
      kind: "bold",
      text: ["до ", { kind: "link", text: "ссылка", url: "https://t.me/x" }, " после"],
    });
  });

  it("обратная косая перед знаком разметки — знак как есть", () => {
    expect(inlineOf("\\*не жирный\\*")).toEqual("*не жирный*");
    expect(inlineOf("\\_ \\[ \\] \\( \\) \\# \\> \\| \\< \\\\ \\-")).toEqual("_ [ ] ( ) # > | < \\ -");
    expect(inlineOf("\\*\\*а\\*\\*")).toEqual("**а**");
  });

  it("экранирование в начале строки отключает блок", () => {
    expect(blocksOf("\\# не заголовок")).toEqual([{ kind: "paragraph", text: "# не заголовок" }]);
    expect(blocksOf("\\- не пункт")).toEqual([{ kind: "paragraph", text: "- не пункт" }]);
    expect(blocksOf("\\> не цитата")).toEqual([{ kind: "paragraph", text: "> не цитата" }]);
    expect(blocksOf("\\| не таблица |")).toEqual([{ kind: "paragraph", text: "| не таблица |" }]);
  });

  it("обратная косая перед другим знаком и в конце строки остаётся как есть", () => {
    expect(inlineOf("\\q и \\")).toEqual("\\q и \\");
  });

  it("подчёркивания внутри слов и в адресах — просто текст", () => {
    expect(inlineOf("snake_case_name и https://t.me/my_channel_name и a _ b")).toEqual("snake_case_name и https://t.me/my_channel_name и a _ b");
    expect(inlineOf("(_курсив_), потом _ещё_.")).toEqual(["(", { kind: "italic", text: "курсив" }, "), потом ", { kind: "italic", text: "ещё" }, "."]);
  });

  it("скобки и знаки без разметочного смысла — текст", () => {
    expect(inlineOf("итог (см. выше) 5 > 3 | a < b, x<5 и <3")).toEqual("итог (см. выше) 5 > 3 | a < b, x<5 и <3");
  });

  it("разметка не пересекает пункты списка, но живёт внутри одного", () => {
    expect(blocksOf("- **а**\n- _б_")).toEqual([{ kind: "list", items: [{ kind: "bold", text: "а" }, { kind: "italic", text: "б" }] }]);
    expect(problemsOf("- **а\n- б**")).toEqual(["строка 1: незакрытый **", "строка 2: незакрытый **"]);
  });

  it("выделение может переходить на следующую строку абзаца", () => {
    expect(inlineOf("**раз\nдва**")).toEqual({ kind: "bold", text: "раз\nдва" });
  });
});

describe("ошибки с номером строки", () => {
  it("незакрытые **, _ и [ — строка открывающего знака", () => {
    expect(problemsOf("Привет **мир")).toEqual(["строка 1: незакрытый **"]);
    expect(problemsOf("Первая\n\nПривет _мир")).toEqual(["строка 3: незакрытый _"]);
    expect(problemsOf("Текст [без конца")).toEqual(["строка 1: незакрытая ["]);
    expect(problemsOf("Раз\nДва **три\nчетыре")).toEqual(["строка 2: незакрытый **"]);
  });

  it("[текст] без (адреса), лишняя ], вложенная [ и незакрытая ( — ошибки", () => {
    expect(problemsOf("[важно] новость")).toEqual(["строка 1: после ] нужна ссылка: [текст](https://…)"]);
    expect(problemsOf("лишняя ]")).toEqual(["строка 1: лишняя ] — для самой скобки пишите \\]"]);
    expect(problemsOf("[а [б](https://t.me/x)")).toEqual(["строка 1: вложенная [ — для самой скобки пишите \\["]);
    expect(problemsOf("[а](https://t.me/x")).toEqual(["строка 1: незакрытая ( в ссылке"]);
    expect(problemsOf("[](https://t.me/x)")).toEqual(["строка 1: пустой текст ссылки"]);
  });

  it("одиночная * и пустые выделения — ошибки с подсказкой", () => {
    expect(problemsOf("*курсив*")).toEqual(["строка 1: одиночная * — для курсива пишите _текст_, для самой звёздочки — \\*"]);
    expect(problemsOf("***и так***")).toEqual(["строка 1: одиночная * — для курсива пишите _текст_, для самой звёздочки — \\*"]);
    expect(problemsOf("****")).toEqual(["строка 1: пустое выделение **"]);
    expect(problemsOf("__")).toEqual(["строка 1: пустое выделение _"]);
    expect(problemsOf("_а _б_ в_")).toEqual(["строка 1: курсив внутри курсива не поддерживается"]);
  });

  it("пересечение выделений называет незакрытый знак", () => {
    expect(problemsOf("**жирный _курсив** хвост_")).toEqual(["строка 1: незакрытый _"]);
    expect(problemsOf("[**а](https://t.me/x)**")).toEqual(["строка 1: незакрытый **"]);
  });

  it("любой HTML-тег, кроме <details> и <summary> на своих строках, — ошибка", () => {
    const tag = (name: string) => `строка 1: тег <${name}> не поддерживается — из HTML разрешены только <details> и <summary>`;
    expect(problemsOf("<b>жирный</b>")).toEqual([tag("b")]);
    expect(problemsOf("<script>alert(1)</script>")).toEqual([tag("script")]);
    expect(problemsOf('<img src=x onerror="alert(1)">')).toEqual([tag("img")]);
    expect(problemsOf("текст <a href=https://t.me/x>ссылка</a>")).toEqual([tag("a")]);
    expect(problemsOf("<!-- комментарий -->")).toEqual(["строка 1: тег <!-- не поддерживается — из HTML разрешены только <details> и <summary>"]);
    expect(problemsOf("<DETAILS>")).toEqual([tag("DETAILS")]);
    expect(problemsOf("</p>")).toEqual([tag("p")]);
  });

  it("<details> и <summary> посреди строки — ошибка про отдельные строки", () => {
    expect(problemsOf("текст <details> ещё")).toEqual(["строка 1: <details> и <summary> пишутся на отдельных строках"]);
    expect(problemsOf("<summary>а</summary> хвост")).toEqual(["строка 1: <details> и <summary> пишутся на отдельных строках"]);
  });

  it("ссылка не https:// — ошибка, как и адрес с логином, пробелом или нечитаемый", () => {
    expect(problemsOf("[сайт](http://t.me/x)")).toEqual(["строка 1: ссылка должна начинаться с https://: http://t.me/x"]);
    for (const url of ["javascript:alert", "javascript:alert%281%29", "//evil.example", "ftp://x.example", "tg://resolve?domain=x", "data:text/html,x", "HTTPS://T.ME/X", "/relative", ""]) {
      expect(problemsOf(`[x](${url})`), url).toEqual([`строка 1: ссылка должна начинаться с https://: ${url}`]);
    }
    expect(problemsOf("[x](https://user:pass@evil.example/)")).toEqual(["строка 1: в адресе ссылки не должно быть логина и пароля"]);
    expect(problemsOf("[x](https://t.me/x y)")).toEqual(["строка 1: в адресе ссылки не должно быть пробелов"]);
    expect(problemsOf("[x](https://)")).toEqual(["строка 1: некорректный адрес ссылки"]);
  });

  it("таблица без строки-разделителя — ошибка со строкой, где он ждался", () => {
    expect(problemsOf("| а | б |\n| 1 | 2 |")).toEqual(["таблица: нет строки-разделителя |---| после заголовка (строка 2)"]);
    expect(problemsOf("Текст\n\n| а | б |")).toEqual(["таблица: нет строки-разделителя |---| после заголовка (строка 4)"]);
    expect(problemsOf("| а | б |\n|:---|---:|")).toEqual(["таблица: нет строки-разделителя |---| после заголовка (строка 2)"]);
    expect(problemsOf("| а | б |\n|---|")).toEqual(["таблица: нет строки-разделителя |---| после заголовка (строка 2)"]);
  });

  it("таблица: ряды разной длины — строка первого неровного ряда", () => {
    expect(problemsOf("| а | б |\n|---|---|\n| 1 | 2 |\n| 3 |\n| 4 | 5 | 6 |")).toEqual(["таблица: ряды разной длины (строка 4)"]);
  });

  it("строка таблицы без закрывающей черты — ошибка", () => {
    expect(problemsOf("| а | б\n|---|---|")).toEqual(["строка 1: строка таблицы должна начинаться и заканчиваться знаком |"]);
    expect(problemsOf("| а | б \\|\n|---|---|")).toEqual(["строка 1: строка таблицы должна начинаться и заканчиваться знаком |"]);
  });

  it("<summary> не сразу после <details> — ошибка; одинокий <summary> — тоже", () => {
    expect(problemsOf("<details>\n\n<summary>X</summary>\nтекст\n</details>")).toEqual([
      "строка 1: сразу после <details> нужна строка <summary>текст</summary>",
      "строка 3: <summary> допустим только сразу после <details>",
    ]);
    expect(problemsOf("<summary>X</summary>")).toEqual(["строка 1: <summary> допустим только сразу после <details>"]);
    expect(problemsOf("<details>\nтекст\n</details>")).toEqual(["строка 1: сразу после <details> нужна строка <summary>текст</summary>"]);
    expect(problemsOf("<details>\n<summary></summary>\nтекст\n</details>")).toEqual(["строка 2: пустой заголовок в <summary>"]);
  });

  it("незакрытый <details> и лишний </details>", () => {
    expect(problemsOf("Текст\n\n<details>\n<summary>X</summary>\nвнутри")).toEqual(["строка 3: незакрытый <details>"]);
    expect(problemsOf("текст\n</details>")).toEqual(["строка 2: лишний </details>"]);
    expect(problemsOf("<details>\n<summary>А</summary>\n<details>\n<summary>Б</summary>\n</details>")).toEqual(["строка 1: незакрытый <details>"]);
  });

  it("<details> до третьего уровня вложенности допустим, четвёртый — ошибка со строкой его тега", () => {
    const nested = (levels: number): string => {
      const open = Array.from({ length: levels }, (_, index) => `<details>\n<summary>Уровень ${String(index + 1)}</summary>`).join("\n");
      return `${open}\nвнутри\n${"</details>\n".repeat(levels)}`.trim();
    };
    expect(problemsOf(nested(3))).toEqual([]);
    expect(problemsOf(nested(4))).toEqual(["строка 7: <details> вложены глубже 3 уровней"]);
  });

  it("пустой исходник — ошибка, документ пуст", () => {
    for (const source of ["", "   ", "\n\n \t\n"]) expect(parseBroadcastMarkdown(source)).toEqual({ doc: { blocks: [] }, problems: ["пустой текст рассылки"] });
  });

  it("управляющие символы и переопределение направления текста — ошибка", () => {
    expect(problemsOf("раз\nдва\u0000три")).toEqual(["строка 2: недопустимый управляющий символ"]);
    expect(problemsOf("\u0007")).toEqual(["строка 1: недопустимый управляющий символ"]);
    expect(problemsOf("[ссылка\u202E](https://t.me/x)")).toEqual(["строка 1: недопустимый управляющий символ"]);
    expect(problemsOf("табуляция\tи перевод\nстроки")).toEqual([]);
  });

  it("несколько ошибок — по порядку строк", () => {
    expect(problemsOf("**а\n\n[б](http://x.example)\n\n#### в")).toEqual([
      "строка 1: незакрытый **",
      "строка 3: ссылка должна начинаться с https://: http://x.example",
      "строка 5: заголовки бывают трёх уровней: #, ## и ###",
    ]);
  });

  it("блок с ошибкой остаётся в документе простым текстом: предпросмотр не пустеет", () => {
    expect(parseBroadcastMarkdown("**а\n\nхорошо")).toEqual({
      doc: {
        blocks: [
          { kind: "paragraph", text: "**а" },
          { kind: "paragraph", text: "хорошо" },
        ],
      },
      problems: ["строка 1: незакрытый **"],
    });
  });
});

describe("пределы", () => {
  const paragraphs = (count: number): string => Array.from({ length: count }, (_, index) => `Абзац ${String(index)}`).join("\n\n");

  it("100 блоков можно, 101 — ошибка про блоки", () => {
    expect(BROADCAST_RICH_LIMITS.blocks).toBe(100);
    expect(problemsOf(paragraphs(100))).toEqual([]);
    expect(problemsOf(paragraphs(101))).toEqual(["блоков больше 100: 101"]);
  });

  it("вложенные блоки считаются тоже: details с сотней абзацев — 101 блок", () => {
    const inner = Array.from({ length: 100 }, (_, index) => `Абзац ${String(index)}`).join("\n\n");
    expect(problemsOf(`<details>\n<summary>Много</summary>\n\n${inner}\n</details>`)).toEqual(["блоков больше 100: 101"]);
    expect(problemsOf(`<details>\n<summary>Много</summary>\n\n${inner.split("\n\n").slice(1).join("\n\n")}\n</details>`)).toEqual([]);
  });

  it("простой текст 4 000 знаков — можно, 4 001 — ошибка из порта", () => {
    expect(problemsOf("а".repeat(4_000))).toEqual([]);
    expect(problemsOf("а".repeat(4_001))).toEqual(["Простой текст для запасного сообщения длиннее 4 000 знаков"]);
  });

  it("исходник длиннее 4 096 знаков не разбирается", () => {
    expect(BROADCAST_RICH_LIMITS.sourceChars).toBe(4_096);
    expect(problemsOf("а".repeat(4_096))).toEqual(["Простой текст для запасного сообщения длиннее 4 000 знаков"]);
    expect(parseBroadcastMarkdown("а".repeat(4_097))).toEqual({ doc: { blocks: [] }, problems: ["исходник длиннее 4096 знаков: 4097"] });
  });

  it("ошибки документа из порта — в тот же список: слишком длинная таблица", () => {
    const wide = `| ${Array.from({ length: 21 }, () => "а").join(" | ")} |`;
    expect(problemsOf(`${wide}\n|${"---|".repeat(21)}`)).toEqual(["Таблица: столбцов больше 20"]);
  });
});

describe("безопасность: произвольный текст из панели", () => {
  /** Все адреса ссылок документа. */
  function linksOf(text: RichText, found: string[] = []): string[] {
    if (typeof text === "string") return found;
    if (Array.isArray(text)) {
      for (const part of text as readonly RichText[]) linksOf(part, found);
      return found;
    }
    const span = text as Exclude<RichText, string | readonly RichText[]>;
    if (span.kind === "link") found.push(span.url);
    if (span.kind !== "dateTime") linksOf(span.text, found);
    return found;
  }

  function allLinks(blocks: readonly RichBlock[]): string[] {
    return blocks.flatMap((block) => {
      switch (block.kind) {
        case "heading":
        case "paragraph":
        case "quote":
        case "footer":
          return linksOf(block.text);
        case "list":
          return block.items.flatMap((item) => linksOf(item));
        case "table":
          return [...(block.header ?? []), ...block.rows.flat()].flatMap((cell) => linksOf(cell));
        case "details":
          return [...linksOf(block.summary), ...allLinks(block.blocks)];
        default:
          return [];
      }
    });
  }

  it("быстрая проверка на враждебных входах: не падает и не виснет, ошибки есть", () => {
    const hostile = [
      "[".repeat(4_096),
      "]".repeat(4_096),
      "**".repeat(2_048),
      "_".repeat(4_096),
      "**_".repeat(1_365),
      "[a](".repeat(1_000),
      "<details>\n".repeat(400),
      "</details>\n".repeat(400),
      "<details>\n<summary>a</summary>\n".repeat(200),
      "|".repeat(4_096),
      "| a |\n|---|\n".repeat(300),
      "\\".repeat(4_096),
      "- ".repeat(2_000),
      "> ".repeat(2_000),
      "#".repeat(4_096),
      "<".repeat(4_096),
      "(".repeat(2_000) + ")".repeat(2_000),
      "\n".repeat(4_096),
    ];
    for (const source of hostile) {
      const parsed = parseBroadcastMarkdown(source);
      expect(Array.isArray(parsed.problems)).toBe(true);
      expect(Array.isArray(parsed.doc.blocks)).toBe(true);
    }
    expect(problemsOf("[".repeat(4_096)).length).toBeGreaterThan(0);
    expect(problemsOf("<details>\n".repeat(400)).length).toBeGreaterThan(0);
  });

  it("случайные сочетания знаков разметки: разбор не бросает, а без ошибок документ годен к отправке и ссылки только https", () => {
    const alphabet = ["*", "**", "_", "[", "]", "(", ")", "\\", "<", ">", "|", "-", "#", "\n", "\n\n", " ", "а", "1.", "---", "https://t.me/x", "<details>\n", "</details>\n", "<summary>", "</summary>", "|---|", "&", "\t"];
    let seed = 20_261_115;
    const next = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed;
    };
    let clean = 0;
    for (let round = 0; round < 3_000; round++) {
      // Короткие строки чаще проходят без ошибок, длинные чаще ломают разбор: нужны оба.
      const longRound = round % 3 === 0;
      let source = "";
      for (let index = 0, length = longRound ? 20 + (next() % 60) : 1 + (next() % 6); index < length; index++) source += alphabet[next() % alphabet.length] ?? "";
      const parsed = parseBroadcastMarkdown(source);
      if (parsed.problems.length > 0) continue;
      clean++;
      expect(richProblems(parsed.doc), source).toEqual([]);
      expect(plainTextOf(parsed.doc).length).toBeLessThanOrEqual(4_000);
      for (const url of allLinks(parsed.doc.blocks)) expect(url.startsWith("https://"), source).toBe(true);
    }
    expect(clean).toBeGreaterThan(100);
  });

  it("разбор не мутирует вход и детерминирован", () => {
    const source = "# А\n\n**б** [в](https://t.me/x)\n\n" + TABLE;
    const first: { doc: RichDocument; problems: string[] } = parseBroadcastMarkdown(source);
    expect(parseBroadcastMarkdown(source)).toEqual(first);
    expect(JSON.parse(JSON.stringify(first.doc))).toEqual(first.doc);
  });
});

describe("отпечаток редакции", () => {
  const base = { format: "rich", text: "# Новость", buttonText: "Играть" };

  it("sha256 в шестнадцатеричном виде, один и тот же для той же редакции", () => {
    expect(editionHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(editionHash({ ...base })).toBe(editionHash(base));
  });

  it("меняется от формата, текста и кнопки по отдельности", () => {
    const hashes = new Set([
      editionHash(base),
      editionHash({ ...base, format: "plain" }),
      editionHash({ ...base, text: "# Новость!" }),
      editionHash({ ...base, buttonText: "Начать" }),
      editionHash({ ...base, buttonText: null }),
    ]);
    expect(hashes.size).toBe(5);
  });

  it("границы полей не склеиваются: «ab»+«c» и «a»+«bc» — разные редакции", () => {
    expect(editionHash({ format: "rich", text: "ab", buttonText: "c" })).not.toBe(editionHash({ format: "rich", text: "a", buttonText: "bc" }));
    expect(editionHash({ format: "rich", text: "a", buttonText: null })).not.toBe(editionHash({ format: "rich", text: "a", buttonText: "null" }));
  });
});
