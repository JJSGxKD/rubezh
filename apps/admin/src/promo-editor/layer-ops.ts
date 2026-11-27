import { FORMATS, MAX_LAYERS, type ImageSource, type PromoDoc, type PromoLayer } from "@bh/promo-kit";

/**
 * Операции над слоями документа (tasks/T-0274): чистые функции, каждая отдаёт
 * новый документ и не трогает старый — иначе стопка отмены хранила бы одну и
 * ту же изменяемую ссылку.
 */

export type LayerKind = PromoLayer["type"];

export const LAYER_KINDS: readonly LayerKind[] = ["text", "image", "rect", "qr", "logo"];

const ID_RE = /^[a-z0-9_]{1,24}$/;

/** Сдвиг копии от оригинала, точек: по нему видно, что слой не один. */
const COPY_OFFSET = 20;

export type OpResult = { ok: true; doc: PromoDoc; id: string } | { ok: false; message: string };

function tooMany(doc: PromoDoc): string | null {
  return doc.layers.length >= MAX_LAYERS ? `В документе уже ${String(MAX_LAYERS)} слоёв — это предел, уберите ненужные` : null;
}

/** Свободный id вида `text_3`: наименьший номер, которого в документе нет. */
export function nextLayerId(doc: PromoDoc, kind: LayerKind): string {
  const taken = new Set(doc.layers.map((layer) => layer.id));
  for (let number = 1; ; number += 1) {
    const id = `${kind}_${String(number)}`;
    if (!taken.has(id)) return id;
  }
}

/** Слой нового вида по центру холста: размеры подобраны так, чтобы слой сразу был виден и читался. */
function freshLayer(doc: PromoDoc, kind: LayerKind, id: string, src: ImageSource): PromoLayer {
  const { width, height } = FORMATS[doc.format];
  const centered = (w: number, h: number) => ({ x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), width: w, height: h });
  const ink = doc.palette[0] ?? "#ffffff";
  switch (kind) {
    case "text": {
      const size = Math.max(24, Math.round(width / 15));
      return { id, type: "text", ...centered(Math.round(width * 0.7), Math.round(size * 1.2)), text: "Новый текст", font: "russo_one", size, weight: 400, color: ink, align: "center", lineHeight: 1.2 };
    }
    case "image":
      return { id, type: "image", ...centered(Math.round(width * 0.6), Math.round(width * 0.6)), src };
    case "rect":
      return { id, type: "rect", ...centered(Math.round(width * 0.5), Math.round(width * 0.25)), fill: doc.palette[1] ?? "#2a2145" };
    case "qr": {
      const side = Math.min(320, Math.round(Math.min(width, height) * 0.3));
      return { id, type: "qr", ...centered(side, side), fg: "#0d0c18", bg: "#ffffff" };
    }
    case "logo":
      return { id, type: "logo", variant: "full", ...centered(Math.round(width * 0.4), Math.round(width * 0.4 * (143 / 454))) };
  }
}

/**
 * Добавить слой сверху. У картинки без выбранного источника — `{ local: true }`:
 * слот под фото партнёра, на холсте он виден заглушкой.
 */
export function addLayer(doc: PromoDoc, kind: LayerKind, src: ImageSource = { local: true }): OpResult {
  const full = tooMany(doc);
  if (full !== null) return { ok: false, message: full };
  const id = nextLayerId(doc, kind);
  return { ok: true, doc: { ...doc, layers: [...doc.layers, freshLayer(doc, kind, id, src)] }, id };
}

export function duplicateLayer(doc: PromoDoc, id: string): OpResult {
  const index = doc.layers.findIndex((layer) => layer.id === id);
  const source = doc.layers[index];
  if (source === undefined) return { ok: false, message: `Слоя «${id}» нет` };
  const full = tooMany(doc);
  if (full !== null) return { ok: false, message: full };
  const copyId = nextLayerId(doc, source.type);
  const copy: PromoLayer = { ...structuredClone(source), id: copyId, x: source.x + COPY_OFFSET, y: source.y + COPY_OFFSET };
  const layers = [...doc.layers];
  layers.splice(index + 1, 0, copy);
  return { ok: true, doc: { ...doc, layers }, id: copyId };
}

export function removeLayer(doc: PromoDoc, id: string): PromoDoc {
  return { ...doc, layers: doc.layers.filter((layer) => layer.id !== id) };
}

/** «Выше» — ближе к концу массива (слои идут снизу вверх); на краю документ не меняется. */
export function moveLayer(doc: PromoDoc, id: string, direction: "up" | "down"): PromoDoc {
  const index = doc.layers.findIndex((layer) => layer.id === id);
  const target = direction === "up" ? index + 1 : index - 1;
  if (index < 0 || target < 0 || target >= doc.layers.length) return doc;
  const layers = [...doc.layers];
  const [layer] = layers.splice(index, 1);
  if (layer === undefined) return doc;
  layers.splice(target, 0, layer);
  return { ...doc, layers };
}

/**
 * У слоя в документе нет отдельного имени — его «имя» это `id`, по которому
 * партнёрские правки находят слой. Поэтому переименование проверяет и формат,
 * и уникальность.
 */
export function renameLayer(doc: PromoDoc, id: string, next: string): OpResult {
  if (next === id) return { ok: true, doc, id };
  if (!ID_RE.test(next)) return { ok: false, message: "Имя слоя: строчная латиница, цифры и «_», до 24 знаков" };
  if (doc.layers.some((layer) => layer.id === next)) return { ok: false, message: `Слой «${next}» уже есть` };
  return { ok: true, doc: { ...doc, layers: doc.layers.map((layer) => (layer.id === id ? { ...layer, id: next } : layer)) }, id: next };
}

/** Поля слоя; остальные слои остаются теми же объектами. */
export function updateLayer(doc: PromoDoc, id: string, patch: Record<string, unknown>): PromoDoc {
  // Слой остаётся слоем своего вида: правят поля, а не вид (`type` из патча — ошибка вызова, не данные).
  return { ...doc, layers: doc.layers.map((layer) => (layer.id === id ? ({ ...layer, ...patch } as PromoLayer) : layer)) };
}

export function updateDoc(doc: PromoDoc, patch: Partial<Pick<PromoDoc, "background" | "palette" | "format">>): PromoDoc {
  return { ...doc, ...patch };
}
