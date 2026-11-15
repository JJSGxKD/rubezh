import { describe, expect, it } from "vitest";
import type { RichDocument } from "../src/platforms/ports/rich-message.js";
import { toTelegramRich } from "../src/platforms/telegram/telegram-rich-render.js";

/**
 * Перевод документа порта в тело `sendRichMessage` (tasks/T-0394, Р199):
 * единственное место, которое знает названия блоков Telegram.
 */

const DOCUMENT: RichDocument = {
  blocks: [
    { kind: "heading", text: "Итоги" },
    { kind: "heading", text: "Мелко", level: 3 },
    { kind: "paragraph", text: ["Место ", { kind: "bold", text: "4" }, " ", { kind: "italic", text: "тихо" }, " ", { kind: "link", text: "таблица", url: "https://rubezh.example/s" }] },
    { kind: "list", items: ["Первое", "Второе"] },
    { kind: "list", items: ["Раз", "Два"], ordered: true },
    {
      kind: "table",
      header: ["Место", "Игрок"],
      rows: [
        ["1", "Дым"],
        ["2", "Искра"],
      ],
    },
    { kind: "details", summary: "Подробнее", blocks: [{ kind: "paragraph", text: "Внутри" }] },
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
    { kind: "paragraph", text: { kind: "dateTime", unix: 1_800_000_000, format: "wDT", fallback: "в понедельник" } },
    { kind: "footer", text: "Рубеж" },
  ],
};

describe("перевод в блоки Telegram", () => {
  const rich = toTelegramRich(DOCUMENT);
  const out = (rich.blocks ?? []) as unknown as Record<string, unknown>[];

  it("типы блоков идут в том же порядке", () => {
    expect(out.map((block) => block.type)).toEqual([
      "heading",
      "heading",
      "paragraph",
      "list",
      "list",
      "table",
      "details",
      "blockquote",
      "photo",
      "photo",
      "buttons",
      "divider",
      "paragraph",
      "footer",
    ]);
  });

  it("заголовок: уровень по умолчанию 2, свой уровень сохраняется", () => {
    expect(out[0]).toEqual({ type: "heading", text: "Итоги", size: 2 });
    expect(out[1]).toMatchObject({ type: "heading", size: 3 });
  });

  it("пометки текста: жирный, курсив, ссылка", () => {
    expect(out[2]).toEqual({
      type: "paragraph",
      text: ["Место ", { type: "bold", text: "4" }, " ", { type: "italic", text: "тихо" }, " ", { type: "url", text: "таблица", url: "https://rubezh.example/s" }],
    });
  });

  it("список: пункт — абзац; у нумерованного значение и тип «1»", () => {
    expect(out[3]).toEqual({ type: "list", items: [{ blocks: [{ type: "paragraph", text: "Первое" }] }, { blocks: [{ type: "paragraph", text: "Второе" }] }] });
    expect(out[4]).toEqual({
      type: "list",
      items: [
        { blocks: [{ type: "paragraph", text: "Раз" }], value: 1, type: "1" },
        { blocks: [{ type: "paragraph", text: "Два" }], value: 2, type: "1" },
      ],
    });
  });

  it("таблица: у первого ряда is_header, полосы включены, ячейки слева сверху", () => {
    const table = out[5] as { type: string; is_striped?: boolean; cells: Record<string, unknown>[][] };
    expect(table.is_striped).toBe(true);
    expect(table.cells).toHaveLength(3);
    expect(table.cells[0]).toEqual([
      { text: "Место", is_header: true, align: "left", valign: "top" },
      { text: "Игрок", is_header: true, align: "left", valign: "top" },
    ]);
    expect(table.cells[1]).toEqual([
      { text: "1", align: "left", valign: "top" },
      { text: "Дым", align: "left", valign: "top" },
    ]);
  });

  it("таблица без заголовка — ни одной ячейки-заголовка", () => {
    const plain = toTelegramRich({ blocks: [{ kind: "table", rows: [["а", "б"]] }] });
    const table = (plain.blocks ?? [])[0] as unknown as { cells: Record<string, unknown>[][] };
    expect(JSON.stringify(table.cells)).not.toContain("is_header");
  });

  it("details, цитата, фото и разделитель", () => {
    expect(out[6]).toEqual({ type: "details", summary: "Подробнее", blocks: [{ type: "paragraph", text: "Внутри" }] });
    expect(out[7]).toEqual({ type: "blockquote", blocks: [{ type: "paragraph", text: "Держи рубеж" }] });
    expect(out[8]).toEqual({ type: "photo", photo: { type: "photo", media: "AgAD" }, caption: { text: "Рекорд" } });
    expect(out[9]).toEqual({ type: "photo", photo: { type: "photo", media: "https://rubezh.example/a.png" } });
    expect(out[11]).toEqual({ type: "divider" });
    expect(out[13]).toEqual({ type: "footer", text: "Рубеж" });
  });

  it("кнопка-ссылка — url, кнопка действия — callback_data", () => {
    expect(out[10]).toEqual({
      type: "buttons",
      buttons: [
        { text: "Играть", url: "https://t.me/rubezh_bot/play" },
        { text: "Не напоминать", callback_data: "rm:off" },
      ],
    });
  });

  it("дата: date_time с unix_time и форматом, в тексте — запасная строка", () => {
    expect(out[12]).toEqual({ type: "paragraph", text: { type: "date_time", text: "в понедельник", unix_time: 1_800_000_000, date_time_format: "wDT" } });
  });
});
