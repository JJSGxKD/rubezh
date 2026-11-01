import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { docProblems, FORMAT_IDS, FORMATS, promoDocSchema, type PromoDoc } from "@bh/promo-kit";

// Стартовые пресеты с артом (design/art/backlog.md п. 15) собирает
// design/art/src/promo-presets.mjs; панель создаёт из них пресет, загружая
// фон профилем `promo_asset` (T-0275). Тест ловит ручную правку генерата и
// фон, который сервер не примет.
const DIR = new URL("../src/screens/promo/art-starters/", import.meta.url);

/** Предел профиля `promo_asset` (T-0273). */
const PROMO_ASSET_MAX_BYTES = 600 * 1024;

const fileSchema = z.object({
  starters: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9_]+$/),
        title: z.string().min(1),
        format: z.enum(FORMAT_IDS),
        image: z.string().regex(/^[a-z0-9_]+\.webp$/),
        doc: z.unknown(),
      }),
    )
    .min(5)
    .max(8),
});

const { starters } = fileSchema.parse(JSON.parse(readFileSync(new URL("presets.json", DIR), "utf8")));

/**
 * Заголовок WebP так же, как его читает сервер (`inspectWebp` в
 * media/image-rules.ts): простой VP8 или VP8L. VP8X — это анимация или
 * метаданные, их сервер не берёт.
 */
function webpInfo(bytes: Buffer): { chunk: string; width: number; height: number } {
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.toString("ascii", 8, 12)).toBe("WEBP");
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8 ") return { chunk, width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { chunk, width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return { chunk, width: 0, height: 0 };
}

function colorsOf(doc: PromoDoc): string[] {
  return doc.layers.flatMap((layer) => {
    if (layer.type === "text") return [layer.color];
    if (layer.type === "rect") return [layer.fill, ...(layer.stroke === undefined ? [] : [layer.stroke])];
    if (layer.type === "qr") return [layer.fg, layer.bg];
    return [];
  });
}

describe("стартовые пресеты промо с артом", () => {
  it("id и названия не повторяются, все форматы генератора есть", () => {
    expect(new Set(starters.map((s) => s.id)).size).toBe(starters.length);
    expect(new Set(starters.map((s) => s.title)).size).toBe(starters.length);
    expect(new Set(starters.map((s) => s.format))).toEqual(new Set(FORMAT_IDS));
  });

  describe.each(starters)("$id", (starter) => {
    const doc = promoDocSchema.parse(starter.doc);
    const bytes = readFileSync(new URL(starter.image, DIR));

    it("документ того же формата и без предупреждений редактора", () => {
      expect(doc.format).toBe(starter.format);
      expect(docProblems(doc)).toEqual([]);
    });

    it("фон — эта картинка: id равен sha256 её байтов, как у сервера", () => {
      expect(doc.background).toEqual({ media: createHash("sha256").update(bytes).digest("hex") });
    });

    it("фон примет профиль promo_asset: WebP без метаданных, в размер формата, до 600 КБ", () => {
      expect(bytes.length).toBeLessThanOrEqual(PROMO_ASSET_MAX_BYTES);
      const info = webpInfo(bytes);
      expect(["VP8 ", "VP8L"]).toContain(info.chunk);
      expect({ width: info.width, height: info.height }).toEqual({ width: FORMATS[doc.format].width, height: FORMATS[doc.format].height });
    });

    it("партнёру есть что менять, а код и QR — нет", () => {
      expect(doc.layers.some((layer) => layer.partner !== undefined && layer.partner !== "none")).toBe(true);
      for (const layer of doc.layers) {
        if (layer.type === "qr" || (layer.type === "text" && layer.text.includes("{code}"))) expect(layer.partner ?? "none").toBe("none");
      }
    });

    it("цвета слоёв — из палитры пресета", () => {
      const palette = new Set(doc.palette.map((color) => color.toLowerCase()));
      for (const color of colorsOf(doc)) expect(palette.has(color.toLowerCase())).toBe(true);
    });
  });
});
