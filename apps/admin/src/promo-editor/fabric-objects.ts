/// <reference types="vite/client" />
import { FORMATS, type PromoDoc } from "@bh/promo-kit";
import { FabricImage, Rect, Textbox, cache, type FabricObject, type StaticCanvas } from "fabric";
import { FONT_FAMILIES, coverCrop, type ImageSpec, type ObjectSpec } from "./fabric-doc";
import { logoImage } from "./logo-svg";
import { qrImageUrl } from "./qr-svg";

/**
 * Слой документа ↔ объект Fabric (tasks/T-0274). Единственное место, где
 * редактор создаёт объекты холста: им пользуются и холст редактора, и
 * выгрузка в полный размер — иначе выгрузка однажды выглядела бы не так, как
 * на экране. Все решения «что рисовать» — в `fabric-doc.ts`, здесь только
 * Fabric.
 */

/**
 * Файлы знака игры берутся как есть, по адресу из сборки, а не копией:
 * `logo.mjs` перерисует знак — и промо подхватит его само. Импортом SVG
 * панель не пользуется (`country-flag.test.ts`), поэтому адрес и `fetch`.
 */
const LOGO_URLS: Record<"full" | "rune", string> = {
  full: new URL("../../../../packages/app-shell/src/design-system/brand/wordmark.svg", import.meta.url).href,
  rune: new URL("../../../../packages/app-shell/src/design-system/brand/rune.svg", import.meta.url).href,
};

/** Разметка знаков после `ensureLogos`; пока её нет, на холсте заглушка. */
const logoMarkup = new Map<"full" | "rune", string>();

/** Прочитать знаки заранее: `signatureOf` и `createObject` синхронно решают, что рисовать. */
export async function ensureLogos(): Promise<void> {
  await Promise.all(
    (["full", "rune"] as const).map(async (variant) => {
      if (logoMarkup.has(variant)) return;
      try {
        const response = await fetch(LOGO_URLS[variant]);
        if (response.ok) logoMarkup.set(variant, await response.text());
      } catch {
        // Знак не открылся — на холсте заглушка, выгрузка предупредит пустым местом.
      }
    }),
  );
}

/** Откуда брать адреса картинок: набор команды, фото партнёра (по id слоя). */
export interface UrlResolver {
  media(id: string): string | null;
  local(layerId: string): string | null;
}

interface Meta {
  layerId: string;
  /** по чему объект пересоздаётся: вид и адрес картинки; текст и фигура обновляются на месте */
  signature: string;
}

const metas = new WeakMap<FabricObject, Meta>();

export const metaOf = (object: FabricObject): Meta | undefined => metas.get(object);

/** Цвета заглушки: холст — не интерфейс, но заглушка должна читаться на любом фоне. */
/** Цвет выделения — токен акцента панели: холст рисует ручки в том же тоне, что кнопки вокруг. */
function accentColor(): string {
  if (typeof document === "undefined") return "#ffb22e";
  const value = getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim();
  return value === "" ? "#ffb22e" : value;
}

const PLACEHOLDER = { fill: "#3a3560", stroke: "#a99fcb" } as const;

interface ResolvedImage {
  url: string;
  /** размер картинки сразу известен (знак, QR) — иначе возьмётся из файла */
  size?: { width: number; height: number };
}

function resolveImage(spec: ImageSpec, urls: UrlResolver): ResolvedImage | null {
  const { source } = spec;
  switch (source.kind) {
    case "media": {
      const url = urls.media(source.id);
      return url === null ? null : { url };
    }
    case "local": {
      const url = urls.local(spec.layerId);
      return url === null ? null : { url };
    }
    case "qr": {
      if (source.data === "") return null;
      const url = qrImageUrl(source.data, source.fg, source.bg, spec.width);
      return url === null ? null : { url, size: { width: spec.width, height: spec.height } };
    }
    case "logo": {
      const markup = logoMarkup.get(source.variant);
      const image = markup === undefined ? null : logoImage(markup, { width: spec.width, height: spec.height });
      return image === null ? null : { url: image.url, size: { width: image.width, height: image.height } };
    }
  }
}

/** По чему объект узнаёт, что его надо создать заново. Пусто — у видов, которые правятся на месте. */
export function signatureOf(spec: ObjectSpec, urls: UrlResolver): string {
  if (spec.kind !== "image") return spec.kind;
  const image = resolveImage(spec, urls);
  return image === null ? "placeholder" : `image:${image.url}`;
}

function placeholder(): Rect {
  return new Rect({ fill: PLACEHOLDER.fill, stroke: PLACEHOLDER.stroke, strokeWidth: 3, strokeDashArray: [14, 10], strokeUniform: true });
}

/** `crossOrigin` — только для чужих адресов: иначе выгрузка холста «запачкается» и браузер её не отдаст. */
async function loadImage(url: string): Promise<FabricImage | null> {
  try {
    const foreign = /^https?:/i.test(url) && new URL(url, window.location.href).origin !== window.location.origin;
    return await FabricImage.fromURL(url, foreign ? { crossOrigin: "anonymous" } : {});
  } catch {
    return null;
  }
}

export async function createObject(spec: ObjectSpec, urls: UrlResolver): Promise<FabricObject> {
  let object: FabricObject;
  if (spec.kind === "text") {
    object = new Textbox(spec.text, { width: spec.width });
  } else if (spec.kind === "rect") {
    object = new Rect({ width: spec.width, height: spec.height });
  } else {
    const resolved = resolveImage(spec, urls);
    const image = resolved === null ? null : await loadImage(resolved.url);
    object = image ?? placeholder();
  }
  metas.set(object, { layerId: spec.layerId, signature: signatureOf(spec, urls) });
  // Цвет и размеры ручек — не часть документа, их кладёт редактор, а не слой.
  const accent = accentColor();
  object.set({ originX: "center", originY: "center", transparentCorners: false, cornerStyle: "circle", cornerSize: 12, touchCornerSize: 28, padding: 0, borderColor: accent, cornerColor: accent, cornerStrokeColor: accent });
  applySpec(object, spec);
  return object;
}

/** Исходный размер картинки на объекте; пусто — объект не картинка (заглушка). */
function naturalSize(image: FabricImage): { width: number; height: number } | null {
  const element = image.getElement();
  const width = "naturalWidth" in element ? element.naturalWidth : element.width;
  const height = "naturalHeight" in element ? element.naturalHeight : element.height;
  return width > 0 && height > 0 ? { width, height } : null;
}

function applyInteraction(object: FabricObject, spec: ObjectSpec): void {
  const full = spec.interaction === "full";
  const none = spec.interaction === "none";
  object.set({
    selectable: !none,
    evented: !none,
    hasControls: full,
    lockMovementX: !full,
    lockMovementY: !full,
    lockRotation: !full,
    lockScalingX: !full,
    lockScalingY: !full,
    hoverCursor: none ? "default" : full ? "move" : "pointer",
    moveCursor: "move",
  });
  // У текста нет «высоты» отдельно от строк, у QR и знака пропорции держит рамка.
  const sidesOnly = spec.kind === "text";
  const cornersOnly = spec.kind === "image" && spec.layerType !== "image";
  object.setControlsVisibility({ mt: !sidesOnly && !cornersOnly, mb: !sidesOnly && !cornersOnly, ml: !cornersOnly, mr: !cornersOnly });
}

/** Привести объект к описанию слоя: вид, размер, положение, возможности. Картинку не перезагружает. */
export function applySpec(object: FabricObject, spec: ObjectSpec): void {
  object.set({ scaleX: 1, scaleY: 1, angle: spec.angle, opacity: spec.opacity, visible: spec.visible });

  if (spec.kind === "text" && object instanceof Textbox) {
    // Редактируемый сейчас текст не трогаем: его ведёт человек, а документ узнает о нём на выходе.
    if (!object.isEditing) object.set({ text: spec.text });
    object.set({ width: spec.width, fontFamily: spec.fontFamily, fontSize: spec.fontSize, fontWeight: spec.fontWeight, fill: spec.fill, textAlign: spec.textAlign, lineHeight: spec.lineHeight, editable: spec.editable, splitByGrapheme: false });
    // Рамка слоя задаёт верхнюю кромку, а высоту даёт текст: центр считается от измеренной высоты.
    object.set({ left: spec.left, top: spec.top - spec.height / 2 + object.height / 2 });
  } else if (spec.kind === "rect" && object instanceof Rect) {
    object.set({ width: spec.width, height: spec.height, fill: spec.fill, rx: spec.rx, ry: spec.rx, stroke: spec.stroke, strokeWidth: spec.strokeWidth, strokeUniform: true, left: spec.left, top: spec.top });
  } else if (spec.kind === "image" && object instanceof FabricImage) {
    const natural = naturalSize(object);
    if (natural === null) {
      object.set({ left: spec.left, top: spec.top });
    } else if (spec.fit === "cover") {
      const crop = coverCrop(natural, { width: spec.width, height: spec.height });
      object.set({ cropX: crop.cropX, cropY: crop.cropY, width: crop.width, height: crop.height, scaleX: crop.scale, scaleY: crop.scale, left: spec.left, top: spec.top });
    } else if (spec.fit === "stretch") {
      object.set({ cropX: 0, cropY: 0, width: natural.width, height: natural.height, scaleX: spec.width / natural.width, scaleY: spec.height / natural.height, left: spec.left, top: spec.top });
    } else {
      // Знак ложится в рамку целиком: его картинка уже собрана ровно под вписанный размер.
      object.set({ cropX: 0, cropY: 0, width: natural.width, height: natural.height, left: spec.left, top: spec.top });
    }
  } else {
    // Заглушка вместо картинки: рамка слоя как есть.
    object.set({ width: spec.width, height: spec.height, left: spec.left, top: spec.top });
  }
  applyInteraction(object, spec);
  object.setCoords();
}

/**
 * Описание объекта по его нынешнему состоянию на холсте. `prev` — описание
 * слоя до правки (с сырым текстом, без подстановок): всё, чего на холсте не
 * правят, берётся из него. Текст берётся с объекта только после правки им.
 */
export function readSpec(object: FabricObject, prev: ObjectSpec, options: { text?: boolean } = {}): ObjectSpec {
  const base = {
    layerId: prev.layerId,
    left: object.left,
    top: object.top,
    width: object.width,
    height: object.height,
    scaleX: object.scaleX,
    scaleY: object.scaleY,
    angle: object.angle,
    opacity: object.opacity,
    visible: object.visible,
    interaction: prev.interaction,
  };
  if (prev.kind === "text") {
    const text = options.text === true && object instanceof Textbox ? object.text : prev.text;
    return { ...prev, ...base, text, fontSize: object instanceof Textbox ? object.fontSize : prev.fontSize };
  }
  if (prev.kind === "rect") return { ...prev, ...base };
  return { ...prev, ...base };
}

const SAMPLE = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя0123456789ABCabc";

/**
 * Шрифты проекта до первой отрисовки: без этого холст нарисует текст
 * системным шрифтом и измерит по нему, а первая выгрузка выйдет «не тем»
 * шрифтом. Кеш ширин букв Fabric сбрасывается — он мог набраться по запасному.
 */
export async function loadFonts(texts: readonly string[]): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  const sample = SAMPLE + texts.join("");
  const wanted = [
    `400 40px "${FONT_FAMILIES.russo_one}"`,
    `400 40px "${FONT_FAMILIES.ibm_plex_sans}"`,
    `700 40px "${FONT_FAMILIES.ibm_plex_sans}"`,
  ];
  await Promise.allSettled(wanted.map((font) => document.fonts.load(font, sample)));
  cache.clearFontCache();
}

/** Фон, если у документа картинка не открылась: тот же тёмный, что у темы игры. */
export const FALLBACK_BACKGROUND = "#120f1e";

/** Фон документа: цвет или картинка «обложкой». Картинка не открылась — `problem` и цвет по умолчанию. */
export async function loadBackground(doc: PromoDoc, urls: UrlResolver): Promise<{ image: FabricImage | null; problem: string | null }> {
  if (typeof doc.background === "string") return { image: null, problem: null };
  const url = urls.media(doc.background.media);
  if (url === null) return { image: null, problem: `Фон «${doc.background.media}» ещё не загружен — пока цвет по умолчанию` };
  const image = await loadImage(url);
  return image === null ? { image: null, problem: `Фон «${doc.background.media}» не открылся — пока цвет по умолчанию` } : { image, problem: null };
}

export function paintBackground(canvas: StaticCanvas, doc: PromoDoc, image: FabricImage | null): void {
  const { width, height } = FORMATS[doc.format];
  if (image === null) {
    canvas.backgroundImage = undefined;
    canvas.backgroundColor = typeof doc.background === "string" ? doc.background : FALLBACK_BACKGROUND;
    return;
  }
  const crop = coverCrop({ width: image.width, height: image.height }, { width, height });
  image.set({ originX: "left", originY: "top", left: 0, top: 0, cropX: crop.cropX, cropY: crop.cropY, width: crop.width, height: crop.height, scaleX: crop.scale, scaleY: crop.scale });
  canvas.backgroundImage = image;
  canvas.backgroundColor = FALLBACK_BACKGROUND;
}
