import { describe, expect, it } from "vitest";
import { plainTextOf, richProblems, RICH_LIMITS, type RichBlock, type RichDocument } from "../src/platforms/ports/rich-message.js";

/**
 * Язык оформленных сообщений бота (tasks/T-0394, Р199): простой текст для MAX,
 * VK и отказа Telegram и проверка документа до отправки. Порт без площадки —
 * здесь ничего не знают о Telegram.
 */

const FULL: RichDocument = {
  blocks: [
    { kind: "heading", text: "Итоги сезона" },
    { kind: "paragraph", text: ["Ты занял ", { kind: "bold", text: "4 место" }, " — ", { kind: "link", text: "таблица", url: "https://rubezh.example/season" }, ", ", { kind: "italic", text: "держись" }, "."] },
    { kind: "list", items: ["Первое", ["Второе ", { kind: "bold", text: "жирное" }]] },
    { kind: "list", items: ["Раз", "Два"], ordered: true },
    {
      kind: "table",
      header: ["Место", "Игрок", "Время"],
      rows: [
        ["1", "Дым", "12:30"],
        ["2", "Искра", "11:05"],
      ],
    },
    { kind: "details", summary: "Подробнее", blocks: [{ kind: "paragraph", text: "Внутри" }, { kind: "footer", text: "Низ вложенного" }] },
    { kind: "quote", text: "Держи рубеж" },
    { kind: "photo", photo: { fileId: "AgAD" }, caption: "Рекорд" },
    { kind: "photo", photo: { url: "https://rubezh.example/a.png" } },
    {
      kind: "buttons",
      buttons: [
        { text: "Играть", url: "https://t.me/rubezh_bot/play" },
        { text: "Не напоминать", action: "rm:off" },
      ],
    },
    { kind: "divider" },
    { kind: "paragraph", text: ["Сезон кончится ", { kind: "dateTime", unix: 1_800_000_000, format: "wDT", fallback: "в понедельник в 03:00" }] },
    { kind: "footer", text: "Рубеж" },
  ],
};

const FULL_PLAIN = [
  "Итоги сезона",
  "Ты занял 4 место — таблица (https://rubezh.example/season), держись.",
  "• Первое\n• Второе жирное",
  "1. Раз\n2. Два",
  "Место · Игрок · Время\n1 · Дым · 12:30\n2 · Искра · 11:05",
  "Подробнее",
  "Внутри",
  "Низ вложенного",
  "«Держи рубеж»",
  "Рекорд",
  "Играть: https://t.me/rubezh_bot/play",
  "",
  "Сезон кончится в понедельник в 03:00",
  "Рубеж",
].join("\n\n");

function details(depth: number): RichBlock {
  let block: RichBlock = { kind: "paragraph", text: "дно" };
  for (let level = 0; level < depth; level++) block = { kind: "details", summary: "уровень", blocks: [block] };
  return block;
}

describe("простой текст оформленного сообщения", () => {
  it("весь набор блоков и пометок — ровно ожидаемая строка", () => {
    expect(plainTextOf(FULL)).toBe(FULL_PLAIN);
  });

  it("ссылка, у которой текст равен адресу, — адрес один раз", () => {
    const url = "https://rubezh.example/season";
    expect(plainTextOf({ blocks: [{ kind: "paragraph", text: { kind: "link", text: url, url } }] })).toBe(url);
  });

  it("кнопки только с действием и фото без подписи не оставляют пустых блоков, края обрезаются", () => {
    const doc: RichDocument = {
      blocks: [
        { kind: "paragraph", text: "  Начало  " },
        { kind: "buttons", buttons: [{ text: "Не напоминать", action: "rm:off" }] },
        { kind: "photo", photo: { fileId: "AgAD" } },
        { kind: "paragraph", text: "Конец" },
      ],
    };
    expect(plainTextOf(doc)).toBe("Начало\n\nКонец");
  });

  it("пустой документ — пустая строка", () => {
    expect(plainTextOf({ blocks: [] })).toBe("");
  });

  it("слишком глубокая вложенность не роняет подсчёт текста", () => {
    expect(() => plainTextOf({ blocks: [details(10_000)] })).not.toThrow();
  });
});

describe("проверка оформленного документа", () => {
  it("годный документ — без ошибок", () => {
    expect(richProblems(FULL)).toEqual([]);
  });

  it("501 блок с вложенными — ошибка про блоки; 500 — годно", () => {
    const pair: RichBlock = { kind: "details", summary: "я", blocks: [{ kind: "paragraph", text: "я" }] };
    const many = (pairs: number, extra: number): RichDocument => ({
      blocks: [...Array.from({ length: pairs }, () => pair), ...Array.from({ length: extra }, (): RichBlock => ({ kind: "divider" }))],
    });
    expect(richProblems(many(250, 0))).toEqual([]);
    const problems = richProblems(many(250, 1));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("блок");
    expect(RICH_LIMITS.blocks).toBe(500);
  });

  it("таблица с 21 столбцом и таблица с рядами разной длины — две ошибки", () => {
    const wide = Array.from({ length: 21 }, (_, index) => String(index));
    const doc: RichDocument = {
      blocks: [
        { kind: "table", rows: [wide] },
        {
          kind: "table",
          rows: [["а", "б"], ["в"]],
        },
      ],
    };
    const problems = richProblems(doc);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("столбц");
    expect(problems[1]).toContain("длин");
  });

  it("заголовок таблицы другой длины, чем ряды, — тоже ошибка", () => {
    expect(richProblems({ blocks: [{ kind: "table", header: ["а"], rows: [["а", "б"]] }] })).toHaveLength(1);
  });

  it("простой текст в 4 001 знак — ошибка про запасной текст; 4 000 — годно", () => {
    expect(richProblems({ blocks: [{ kind: "paragraph", text: "я".repeat(4_000) }] })).toEqual([]);
    const problems = richProblems({ blocks: [{ kind: "paragraph", text: "я".repeat(4_001) }] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("запасн");
  });

  it("видимого текста больше 32 768 знаков — ошибка (и запасной текст тоже длинный)", () => {
    const problems = richProblems({ blocks: [{ kind: "paragraph", text: "я".repeat(32_769) }] });
    expect(problems.some((problem) => problem.includes("32 768"))).toBe(true);
  });

  it("кнопка с адресом http:// — ошибка; ссылка и фото по http:// — тоже", () => {
    expect(richProblems({ blocks: [{ kind: "buttons", buttons: [{ text: "Играть", url: "http://rubezh.example" }] }] })).toHaveLength(1);
    expect(richProblems({ blocks: [{ kind: "paragraph", text: { kind: "link", text: "тут", url: "http://rubezh.example" } }] })).toHaveLength(1);
    expect(richProblems({ blocks: [{ kind: "photo", photo: { url: "http://rubezh.example/a.png" } }] })).toHaveLength(1);
  });

  it("action из 65 байт — ошибка, из 64 — годно; кириллица считается байтами", () => {
    expect(richProblems({ blocks: [{ kind: "buttons", buttons: [{ text: "Ок", action: "a".repeat(64) }] }] })).toEqual([]);
    expect(richProblems({ blocks: [{ kind: "buttons", buttons: [{ text: "Ок", action: "a".repeat(65) }] }] })).toHaveLength(1);
    expect(richProblems({ blocks: [{ kind: "buttons", buttons: [{ text: "Ок", action: "я".repeat(33) }] }] })).toHaveLength(1);
  });

  it("ряд кнопок: 0 и 9 — ошибка, 8 — годно", () => {
    const button = { text: "Ок", url: "https://rubezh.example" };
    expect(richProblems({ blocks: [{ kind: "buttons", buttons: [] }] })).toHaveLength(1);
    expect(richProblems({ blocks: [{ kind: "buttons", buttons: Array.from({ length: 9 }, () => button) }] })).toHaveLength(1);
    expect(richProblems({ blocks: [{ kind: "buttons", buttons: Array.from({ length: 8 }, () => button) }] })).toEqual([]);
  });

  it("вложенность 17 details — ошибка, 15 — годно", () => {
    expect(richProblems({ blocks: [details(15)] })).toEqual([]);
    const problems = richProblems({ blocks: [details(17)] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("вложенн");
  });

  it("фото больше 50 — ошибка", () => {
    const photo: RichBlock = { kind: "photo", photo: { fileId: "AgAD" } };
    expect(richProblems({ blocks: Array.from({ length: 50 }, () => photo) })).toEqual([]);
    const problems = richProblems({ blocks: Array.from({ length: 51 }, () => photo) });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("фото");
  });

  it("unix у даты — целое положительное число", () => {
    const at = (unix: number): RichDocument => ({ blocks: [{ kind: "paragraph", text: { kind: "dateTime", unix, format: "r", fallback: "скоро" } }] });
    expect(richProblems(at(1_800_000_000))).toEqual([]);
    for (const bad of [0, -5, 1.5, Number.NaN]) expect(richProblems(at(bad)), String(bad)).toHaveLength(1);
  });

  it("слишком глубокое дерево не роняет проверку", () => {
    expect(richProblems({ blocks: [details(10_000)] }).length).toBeGreaterThan(0);
  });
});
