import { FORMATS } from "./formats.js";
import type { PromoDoc } from "./doc.js";

/** Меньше этой стороны QR не читается камерой с экрана телефона. */
export const MIN_QR_SIDE = 160;

/** Мельче этого кегля на сторис текст не читается на телефоне. */
export const MIN_STORY_TEXT_SIZE = 24;

/**
 * Предупреждения редактора, не отказ схемы: документ с проблемами сохранить
 * можно, но выложить его не стоит. Скрытые слои, кроме повтора `id`, не
 * проверяются — их не видно. Повороты не учитываются: слой «за холстом» значит
 * без поворота.
 */
export function docProblems(doc: PromoDoc): string[] {
  const problems: string[] = [];
  const { width, height } = FORMATS[doc.format];

  const seen = new Set<string>();
  for (const layer of doc.layers) {
    if (seen.has(layer.id)) problems.push(`повтор id «${layer.id}»: правки партнёра и редактор перепутают слои`);
    seen.add(layer.id);
  }

  for (const layer of doc.layers) {
    if (layer.hidden === true) continue;
    const outside = layer.x >= width || layer.y >= height || layer.x + layer.width <= 0 || layer.y + layer.height <= 0;
    if (outside) problems.push(`слой «${layer.id}» целиком за холстом ${String(width)}×${String(height)}`);
    if (layer.type === "qr" && Math.min(layer.width, layer.height) < MIN_QR_SIDE) {
      problems.push(`QR «${layer.id}» меньше ${String(MIN_QR_SIDE)} точек — не прочитается`);
    }
    if (layer.type === "text" && doc.format === "story" && layer.size < MIN_STORY_TEXT_SIZE) {
      problems.push(`текст «${layer.id}»: кегль ${String(layer.size)} меньше ${String(MIN_STORY_TEXT_SIZE)} на сторис — мелко на телефоне`);
    }
  }
  return problems;
}
