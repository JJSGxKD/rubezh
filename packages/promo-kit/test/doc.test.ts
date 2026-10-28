import { describe, expect, it } from "vitest";
import { promoDocSchema } from "../src/index.js";
import { baseDoc } from "./helpers.js";

describe("схема документа", () => {
  it("корректный документ проходит", () => {
    expect(promoDocSchema.safeParse(baseDoc()).success).toBe(true);
  });

  it("41 слой — ошибка, 40 — можно", () => {
    const layer = baseDoc().layers[0];
    const many = (count: number) => ({ ...baseDoc(), layers: Array.from({ length: count }, (_, k) => ({ ...layer, id: `l${String(k)}` })) });
    expect(promoDocSchema.safeParse(many(40)).success).toBe(true);
    expect(promoDocSchema.safeParse(many(41)).success).toBe(false);
  });

  it("повтор id схема пропускает — это проблема для редактора, не отказ", () => {
    const doc = baseDoc();
    doc.layers.push({ ...doc.layers[0] });
    expect(promoDocSchema.safeParse(doc).success).toBe(true);
  });

  it("шрифт вне списка — ошибка", () => {
    const doc = baseDoc() as unknown as { layers: Record<string, unknown>[] };
    doc.layers[0].font = "comic";
    expect(promoDocSchema.safeParse(doc).success).toBe(false);
  });

  it("цвет не #rrggbb — ошибка: в тексте, фоне и палитре", () => {
    const text = baseDoc() as unknown as { layers: Record<string, unknown>[] };
    text.layers[0].color = "red";
    expect(promoDocSchema.safeParse(text).success).toBe(false);
    expect(promoDocSchema.safeParse({ ...baseDoc(), background: "red" }).success).toBe(false);
    expect(promoDocSchema.safeParse({ ...baseDoc(), palette: ["#fff"] }).success).toBe(false);
  });

  it("палитра — не больше восьми цветов", () => {
    const palette = Array.from({ length: 9 }, () => "#aabbcc");
    expect(promoDocSchema.safeParse({ ...baseDoc(), palette: palette.slice(0, 8) }).success).toBe(true);
    expect(promoDocSchema.safeParse({ ...baseDoc(), palette }).success).toBe(false);
  });

  it("фон — картинка из media", () => {
    expect(promoDocSchema.safeParse({ ...baseDoc(), background: { media: "bg_winter" } }).success).toBe(true);
    expect(promoDocSchema.safeParse({ ...baseDoc(), background: { media: "" } }).success).toBe(false);
  });

  it("слой: id по маске, прозрачность 0…1, поворот −180…180", () => {
    const withLayer = (patch: Record<string, unknown>) => {
      const doc = baseDoc() as unknown as { layers: Record<string, unknown>[] };
      doc.layers[0] = { ...doc.layers[0], ...patch };
      return promoDocSchema.safeParse(doc).success;
    };
    expect(withLayer({ id: "Bad Id" })).toBe(false);
    expect(withLayer({ id: "a".repeat(25) })).toBe(false);
    expect(withLayer({ opacity: 1.2 })).toBe(false);
    expect(withLayer({ rotation: 181 })).toBe(false);
    expect(withLayer({ rotation: -180, opacity: 0 })).toBe(true);
  });

  it("текст: до 300 знаков, кегль 12…240, вес 400 или 700, межстрочный 0,8…2", () => {
    const withText = (patch: Record<string, unknown>) => {
      const doc = baseDoc() as unknown as { layers: Record<string, unknown>[] };
      doc.layers[0] = { ...doc.layers[0], ...patch };
      return promoDocSchema.safeParse(doc).success;
    };
    expect(withText({ text: "а".repeat(300) })).toBe(true);
    expect(withText({ text: "а".repeat(301) })).toBe(false);
    expect(withText({ size: 11 })).toBe(false);
    expect(withText({ size: 241 })).toBe(false);
    expect(withText({ weight: 500 })).toBe(false);
    expect(withText({ lineHeight: 0.7 })).toBe(false);
    expect(withText({ lineHeight: 2.1 })).toBe(false);
  });

  it("картинка слоя: из media или локальная; без источника — ошибка", () => {
    const image = (src: unknown) => {
      const doc = baseDoc() as unknown as { layers: Record<string, unknown>[] };
      doc.layers.push({ id: "pic", type: "image", x: 0, y: 0, width: 100, height: 100, src });
      return promoDocSchema.safeParse(doc).success;
    };
    expect(image({ media: "photo_1" })).toBe(true);
    expect(image({ local: true })).toBe(true);
    expect(image({ local: false })).toBe(false);
    expect(image({})).toBe(false);
  });

  it("QR — квадрат; значок — full или rune", () => {
    const doc = baseDoc();
    const qr = doc.layers.find((layer) => layer.type === "qr")!;
    qr.width = 300;
    expect(promoDocSchema.safeParse(doc).success).toBe(false);
    const logo = baseDoc() as unknown as { layers: Record<string, unknown>[] };
    logo.layers[3].variant = "other";
    expect(promoDocSchema.safeParse(logo).success).toBe(false);
  });

  it("версия только первая; неизвестный формат — ошибка", () => {
    expect(promoDocSchema.safeParse({ ...baseDoc(), version: 2 }).success).toBe(false);
    expect(promoDocSchema.safeParse({ ...baseDoc(), format: "poster" }).success).toBe(false);
  });
});
