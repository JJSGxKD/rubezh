import { z } from "zod";
import { MAX_TEXT_LENGTH, imageSourceSchema, type PromoDoc, type PromoLayer } from "./doc.js";

/** Правка партнёра отклонена: `layerId` — слой, на котором она остановилась. */
export class PartnerEditError extends Error {
  constructor(
    readonly layerId: string,
    message: string,
  ) {
    super(`слой «${layerId}»: ${message}`);
    this.name = "PartnerEditError";
  }
}

/**
 * Правки партнёра: `{ layers: { <id слоя>: { text | src | color } } }`. Форма
 * намеренно свободная — что из этого разрешено, решает `applyPartnerEdits` по
 * правам слоя, а не схема.
 */
export const partnerEditsSchema = z.object({
  layers: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

export type PartnerEdits = z.input<typeof partnerEditsSchema>;

/** Поле правки → право, которое для неё нужно. Всё прочее (положение, размер, шрифт, порядок, скрытие) не менялось и не меняется. */
const FIELD_RIGHT = { text: "text", src: "image", color: "color" } as const;

/** Поле цвета слоя: у текста — цвет букв, у прямоугольника — заливка, у QR — цвет модулей. */
function setColor(layer: PromoLayer, color: string): boolean {
  if (layer.type === "text") layer.color = color;
  else if (layer.type === "rect") layer.fill = color;
  else if (layer.type === "qr") layer.fg = color;
  else return false;
  return true;
}

/**
 * Применить правки партнёра к шаблону и отдать новый документ; шаблон не
 * меняется. Принимается только разрешённое слоем (`partner`): текст — у `text`,
 * замена картинки своим фото — у `image`, цвет из палитры документа — у
 * `color`. Остальное — `PartnerEditError` с id слоя.
 */
export function applyPartnerEdits(template: PromoDoc, edits: PartnerEdits): PromoDoc {
  const result = structuredClone(template);
  const palette = new Set(template.palette.map((color) => color.toLowerCase()));

  for (const [layerId, fields] of Object.entries(edits.layers ?? {})) {
    const layer = result.layers.find((candidate) => candidate.id === layerId);
    if (layer === undefined) throw new PartnerEditError(layerId, "такого слоя в шаблоне нет");
    const right = layer.partner ?? "none";

    for (const [field, value] of Object.entries(fields)) {
      if (!Object.hasOwn(FIELD_RIGHT, field)) throw new PartnerEditError(layerId, `поле «${field}» партнёр менять не может`);
      const needed = FIELD_RIGHT[field as keyof typeof FIELD_RIGHT];
      if (right !== needed) throw new PartnerEditError(layerId, `слой не разрешает менять «${field}» (права: ${right})`);

      if (field === "text") {
        if (layer.type !== "text") throw new PartnerEditError(layerId, "текст есть только у текстового слоя");
        if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH) throw new PartnerEditError(layerId, `текст — строка не длиннее ${String(MAX_TEXT_LENGTH)} знаков`);
        layer.text = value;
      } else if (field === "src") {
        if (layer.type !== "image") throw new PartnerEditError(layerId, "картинка есть только у слоя-картинки");
        const parsed = imageSourceSchema.safeParse(value);
        if (!parsed.success || !("local" in parsed.data)) throw new PartnerEditError(layerId, "картинку можно заменить только своим фото ({ local: true })");
        layer.src = parsed.data;
      } else {
        if (typeof value !== "string" || !palette.has(value.toLowerCase())) throw new PartnerEditError(layerId, "цвет не из палитры шаблона");
        if (!setColor(layer, value.toLowerCase())) throw new PartnerEditError(layerId, "у слоя нет цвета, который можно менять");
      }
    }
  }
  return result;
}
