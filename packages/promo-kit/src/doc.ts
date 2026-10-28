import { z } from "zod";
import { FORMAT_IDS } from "./formats.js";

/** Сколько слоёв в документе: больше редактору не нужно, а сервер не должен принимать сколько угодно. */
export const MAX_LAYERS = 40;

/** Сколько цветов в палитре пресета — из неё партнёр выбирает цвет. */
export const MAX_PALETTE = 8;

/** Предел длины текста слоя. */
export const MAX_TEXT_LENGTH = 300;

export const FONTS = ["russo_one", "ibm_plex_sans"] as const;
export const PARTNER_RIGHTS = ["none", "text", "image", "color"] as const;

export type PartnerRight = (typeof PARTNER_RIGHTS)[number];

/** Цвет `#rrggbb`; регистр не важен, при сравнении с палитрой приводится к нижнему. */
export const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "цвет должен быть вида #rrggbb");

const mediaIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "id картинки: латиница, цифры, «_» и «-», до 64 знаков");

/** Источник картинки: из набора `media` либо фото партнёра, которое остаётся у него и на сервер не уходит. */
export const imageSourceSchema = z.union([z.strictObject({ media: mediaIdSchema }), z.strictObject({ local: z.literal(true) })]);

const point = z.number().finite();
const size = z.number().finite().positive();

/** Общие поля слоя; положение и размер — в точках формата. */
const layerBase = {
  id: z.string().regex(/^[a-z0-9_]{1,24}$/, "id слоя: строчная латиница, цифры и «_», до 24 знаков"),
  x: point,
  y: point,
  width: size,
  height: size,
  rotation: z.number().min(-180).max(180).optional(),
  opacity: z.number().min(0).max(1).optional(),
  hidden: z.boolean().optional(),
  /** что партнёр вправе менять в слое; не задано — ничего */
  partner: z.enum(PARTNER_RIGHTS).optional(),
};

const textLayer = z.object({
  ...layerBase,
  type: z.literal("text"),
  text: z.string().max(MAX_TEXT_LENGTH),
  font: z.enum(FONTS),
  size: z.number().min(12).max(240),
  weight: z.union([z.literal(400), z.literal(700)]),
  color: colorSchema,
  align: z.enum(["left", "center", "right"]),
  lineHeight: z.number().min(0.8).max(2),
});

const imageLayer = z.object({ ...layerBase, type: z.literal("image"), src: imageSourceSchema });

const rectLayer = z.object({
  ...layerBase,
  type: z.literal("rect"),
  fill: colorSchema,
  radius: z.number().min(0).max(540).optional(),
  stroke: colorSchema.optional(),
  strokeWidth: z.number().min(0).optional(),
});

const qrLayer = z
  .object({
    ...layerBase,
    type: z.literal("qr"),
    fg: colorSchema,
    bg: colorSchema,
    /** адрес, который кодирует QR; ставит `resolveDoc` из переменной `{link}`, в шаблоне его нет */
    data: z.string().max(2048).optional(),
  })
  .refine((layer) => layer.width === layer.height, { message: "сторона QR квадратная: ширина равна высоте", path: ["height"] });

const logoLayer = z.object({ ...layerBase, type: z.literal("logo"), variant: z.enum(["full", "rune"]) });

export const layerSchema = z.discriminatedUnion("type", [textLayer, imageLayer, rectLayer, qrLayer, logoLayer]);

/**
 * Документ промо-материала (Р159): формат, фон, палитра для правок партнёра и
 * слои снизу вверх. Повтор `id` слоя схема пропускает — это предупреждение
 * редактора (`docProblems`), а не отказ.
 */
export const promoDocSchema = z.object({
  version: z.literal(1),
  format: z.enum(FORMAT_IDS),
  /** цвет или картинка из `media` */
  background: z.union([colorSchema, z.strictObject({ media: mediaIdSchema })]),
  palette: z.array(colorSchema).max(MAX_PALETTE),
  layers: z.array(layerSchema).max(MAX_LAYERS),
});

export type PromoDoc = z.infer<typeof promoDocSchema>;
export type PromoLayer = z.infer<typeof layerSchema>;
export type TextLayer = z.infer<typeof textLayer>;
export type ImageSource = z.infer<typeof imageSourceSchema>;
