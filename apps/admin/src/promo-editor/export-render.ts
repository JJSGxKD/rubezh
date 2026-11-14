import { FORMATS, resolveDoc, type PromoDoc, type PromoVars } from "@bh/promo-kit";
import { StaticCanvas } from "fabric";
import { layerToObject } from "./fabric-doc";
import { createObject, loadBackground, loadFonts, paintBackground, type UrlResolver } from "./fabric-objects";

/**
 * Отрисовка документа в полный размер формата на отдельном холсте
 * (tasks/T-0274). Объекты создаются теми же `createObject`, что и на холсте
 * редактора, поэтому выгрузка не расходится с тем, что видно на экране.
 * Подгружается лениво из `export.ts` — Fabric в первую загрузку панели не
 * входит.
 */
export async function renderDoc(doc: PromoDoc, vars: PromoVars, type: "png" | "jpeg", quality: number, urls: UrlResolver): Promise<Blob> {
  // Без запасных значений: на картинке не должно остаться «{code}» — пустое место честнее.
  const resolved = resolveDoc(doc, vars);
  const { width, height } = FORMATS[resolved.format];
  await loadFonts(resolved.layers.flatMap((layer) => (layer.type === "text" ? [layer.text] : [])));

  // Размер буфера — ровно формат, без поправки на плотность экрана: файл не должен зависеть от монитора.
  const canvas = new StaticCanvas(undefined, { width, height, enableRetinaScaling: false, renderOnAddRemove: false });
  try {
    const background = await loadBackground(resolved, urls);
    paintBackground(canvas, resolved, background.image);
    for (const layer of resolved.layers) {
      if (layer.hidden === true) continue;
      canvas.add(await createObject(layerToObject(layer, { mode: "team" }), urls));
    }
    canvas.renderAll();
    const blob = await canvas.toBlob({ format: type, quality, multiplier: 1 });
    if (blob === null) throw new Error("Браузер не смог собрать картинку");
    return blob;
  } finally {
    void canvas.dispose();
  }
}
