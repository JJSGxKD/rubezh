import { VAR_NAMES, resolveDoc, type FONTS, type PromoDoc, type PromoLayer, type PromoVars } from "@bh/promo-kit";

/**
 * Перевод слоя документа в объект Fabric и обратно (docs/35-stage4-plan.md
 * Р159, tasks/T-0274). Здесь нет ни Fabric, ни DOM: функции работают с
 * простыми описаниями объектов (`ObjectSpec`), поэтому проверяются тестом в
 * Node. Холст Fabric — отображение; источник истины — документ, и каждое
 * изменение на холсте возвращается в него через `objectToLayer`.
 *
 * Положение объекта — центр слоя: тогда поворот идёт вокруг центра, как у
 * Fabric, а `x`, `y`, `width`, `height` слоя остаются рамкой до поворота.
 * Масштаб (`scaleX`, `scaleY`) в документ не попадает: он сводится к размеру
 * слоя, а холст после этого возвращается к масштабу 1.
 */

export type Mode = "team" | "partner";

/** Что можно делать с объектом на холсте: всё, только выбрать (редактировать свойства) или ничего. */
export type Interaction = "full" | "select" | "none";

export interface ObjectContext {
  mode: Mode;
  /** закреплённые слои: выбираются, но не двигаются (память редактора, в документ не входят) */
  locked?: ReadonlySet<string>;
}

type Font = (typeof FONTS)[number];

/** Гарнитуры проекта (`@fontsource` в панели): имя семейства, как оно объявлено в `styles.css`. */
export const FONT_FAMILIES: Record<Font, string> = {
  russo_one: "Russo One",
  ibm_plex_sans: "IBM Plex Sans Variable",
};

/** Откуда брать картинку: редактор по этому описанию выбирает адрес и не знает схему документа. */
export type ImageSourceSpec =
  | { kind: "media"; id: string }
  | { kind: "local" }
  | { kind: "logo"; variant: "full" | "rune" }
  | { kind: "qr"; data: string; fg: string; bg: string };

/** Как картинка ложится в рамку слоя: обрезать по центру, вписать целиком или растянуть (рамка неизвестна). */
export type ImageFit = "cover" | "contain" | "stretch";

interface SpecBase {
  layerId: string;
  /** центр объекта */
  left: number;
  top: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  angle: number;
  opacity: number;
  visible: boolean;
  interaction: Interaction;
}

export interface TextSpec extends SpecBase {
  kind: "text";
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fill: string;
  textAlign: "left" | "center" | "right";
  lineHeight: number;
  editable: boolean;
}

export interface RectSpec extends SpecBase {
  kind: "rect";
  fill: string;
  rx: number;
  stroke: string | null;
  strokeWidth: number;
}

export interface ImageSpec extends SpecBase {
  kind: "image";
  layerType: "image" | "qr" | "logo";
  source: ImageSourceSpec;
  fit: ImageFit;
}

export type ObjectSpec = TextSpec | RectSpec | ImageSpec;

const round = (value: number): number => Math.round(value * 100) / 100 + 0;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Угол в границы схемы, −180…180, с точностью до сотых. */
export function normalizeAngle(angle: number): number {
  const wrapped = ((((angle + 180) % 360) + 360) % 360) - 180;
  return round(wrapped);
}

function interactionOf(layer: PromoLayer, ctx: ObjectContext): Interaction {
  if (ctx.mode === "partner") return (layer.partner ?? "none") === "none" ? "none" : "select";
  return ctx.locked?.has(layer.id) === true ? "select" : "full";
}

export function layerToObject(layer: PromoLayer, ctx: ObjectContext): ObjectSpec {
  const base: SpecBase = {
    layerId: layer.id,
    left: layer.x + layer.width / 2,
    top: layer.y + layer.height / 2,
    width: layer.width,
    height: layer.height,
    scaleX: 1,
    scaleY: 1,
    angle: layer.rotation ?? 0,
    opacity: layer.opacity ?? 1,
    visible: layer.hidden !== true,
    interaction: interactionOf(layer, ctx),
  };
  switch (layer.type) {
    case "text":
      return {
        ...base,
        kind: "text",
        text: layer.text,
        fontFamily: FONT_FAMILIES[layer.font],
        fontSize: layer.size,
        fontWeight: layer.weight,
        fill: layer.color,
        textAlign: layer.align,
        lineHeight: layer.lineHeight,
        editable: ctx.mode === "team" || layer.partner === "text",
      };
    case "rect":
      return { ...base, kind: "rect", fill: layer.fill, rx: layer.radius ?? 0, stroke: layer.stroke ?? null, strokeWidth: layer.strokeWidth ?? 0 };
    case "image":
      return { ...base, kind: "image", layerType: "image", source: "media" in layer.src ? { kind: "media", id: layer.src.media } : { kind: "local" }, fit: "cover" };
    case "qr":
      return { ...base, kind: "image", layerType: "qr", source: { kind: "qr", data: layer.data ?? "", fg: layer.fg, bg: layer.bg }, fit: "stretch" };
    case "logo":
      return { ...base, kind: "image", layerType: "logo", source: { kind: "logo", variant: layer.variant }, fit: "contain" };
  }
}

/**
 * Поля слоя, общие для всех видов. Необязательное поле остаётся в слое, только
 * если оно было или стало не умолчанием: документ без правок не обрастает
 * `rotation: 0` и `opacity: 1`.
 */
function commonFields(object: ObjectSpec, prev: PromoLayer, width: number, height: number) {
  const angle = normalizeAngle(object.angle);
  return {
    id: prev.id,
    x: round(object.left - width / 2),
    y: round(object.top - height / 2),
    width: round(width),
    height: round(height),
    ...(angle !== 0 || prev.rotation !== undefined ? { rotation: angle } : {}),
    ...(object.opacity !== 1 || prev.opacity !== undefined ? { opacity: round(object.opacity) } : {}),
    ...(!object.visible ? { hidden: true } : prev.hidden === false ? { hidden: false } : {}),
    ...(prev.partner === undefined ? {} : { partner: prev.partner }),
  };
}

function mismatch(prev: PromoLayer, object: ObjectSpec): Error {
  return new Error(`Объект вида «${object.kind}» не подходит слою «${prev.id}» вида «${prev.type}»`);
}

/**
 * Объект Fabric → слой. `prev` — прежний слой: из него берётся всё, чего на
 * холсте не меняют (шрифт, права партнёра, источник картинки, цвета QR).
 */
export function objectToLayer(object: ObjectSpec, prev: PromoLayer): PromoLayer {
  const scaledWidth = object.width * object.scaleX;
  const scaledHeight = object.height * object.scaleY;
  switch (prev.type) {
    case "text": {
      if (object.kind !== "text") throw mismatch(prev, object);
      // Боковая ручка меняет ширину, угловая — и ширину, и кегль: у текста нет другой «высоты», кроме строк.
      const size = clamp(Math.round(object.fontSize * object.scaleY), 12, 240);
      return {
        ...commonFields(object, prev, scaledWidth, scaledHeight),
        type: "text",
        text: object.text,
        font: prev.font,
        size,
        weight: object.fontWeight === 700 ? 700 : 400,
        color: object.fill,
        align: object.textAlign,
        lineHeight: round(object.lineHeight),
      };
    }
    case "rect": {
      if (object.kind !== "rect") throw mismatch(prev, object);
      return {
        ...commonFields(object, prev, scaledWidth, scaledHeight),
        type: "rect",
        fill: object.fill,
        ...(object.rx > 0 ? { radius: round(object.rx) } : prev.radius === undefined ? {} : { radius: 0 }),
        ...(object.stroke === null ? {} : { stroke: object.stroke }),
        ...(object.strokeWidth > 0 ? { strokeWidth: round(object.strokeWidth) } : prev.strokeWidth === undefined ? {} : { strokeWidth: 0 }),
      };
    }
    case "image": {
      if (object.kind !== "image") throw mismatch(prev, object);
      return { ...commonFields(object, prev, scaledWidth, scaledHeight), type: "image", src: prev.src };
    }
    case "qr": {
      if (object.kind !== "image") throw mismatch(prev, object);
      // Сторона квадратная: берём большую, чтобы вытянутый вдоль одной оси код не уменьшался.
      const side = Math.max(scaledWidth, scaledHeight);
      return {
        ...commonFields(object, prev, side, side),
        type: "qr",
        fg: prev.fg,
        bg: prev.bg,
        ...(prev.data === undefined ? {} : { data: prev.data }),
      };
    }
    case "logo": {
      if (object.kind !== "image") throw mismatch(prev, object);
      return { ...commonFields(object, prev, scaledWidth, scaledHeight), type: "logo", variant: prev.variant };
    }
  }
}

export interface Size {
  width: number;
  height: number;
}

export interface CoverCrop {
  /** размер видимой части исходника, его точки */
  width: number;
  height: number;
  cropX: number;
  cropY: number;
  scale: number;
}

/** «Обложка»: картинка закрывает рамку целиком, лишнее срезается по центру, пропорции целы. */
export function coverCrop(natural: Size, box: Size): CoverCrop {
  const scale = Math.max(box.width / natural.width, box.height / natural.height);
  const width = box.width / scale;
  const height = box.height / scale;
  return { width, height, cropX: (natural.width - width) / 2, cropY: (natural.height - height) / 2, scale };
}

/** «Вписать»: картинка целиком внутри рамки, пропорции целы. */
export function containFit(natural: Size, box: Size): Size {
  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  return { width: natural.width * scale, height: natural.height * scale };
}

/**
 * Документ в том виде, в каком он лежит на холсте: переменные подставлены, а
 * где значения нет — остаётся `{code}`, чтобы в редакторе было видно место
 * (`resolveDoc` в этом случае оставил бы пустоту). У QR без ссылки данные —
 * тоже `{link}`: код рисуется заглушкой, а не пропадает.
 */
export function viewDoc(doc: PromoDoc, vars: PromoVars): PromoDoc {
  const filled: PromoVars = {};
  for (const name of VAR_NAMES) {
    const value = vars[name];
    filled[name] = value === undefined || value === "" ? `{${name}}` : value;
  }
  return resolveDoc(doc, filled);
}

const VAR_RE = /\{(code|link|reward)\}/g;

/**
 * Слои, у которых на холсте стоит заглушка вместо значения: их редактор
 * обводит пунктиром — «подставится при выгрузке». Скрытые не считаются.
 */
export function pendingLayerIds(doc: PromoDoc, vars: PromoVars): string[] {
  const has = (name: string): boolean => {
    const value = vars[name as keyof PromoVars];
    return value !== undefined && value !== "";
  };
  const pending: string[] = [];
  for (const layer of doc.layers) {
    if (layer.hidden === true) continue;
    if (layer.type === "qr") {
      if (!has("link")) pending.push(layer.id);
    } else if (layer.type === "text") {
      for (const match of layer.text.matchAll(VAR_RE)) {
        if (!has(match[1] ?? "")) {
          pending.push(layer.id);
          break;
        }
      }
    }
  }
  return pending;
}
